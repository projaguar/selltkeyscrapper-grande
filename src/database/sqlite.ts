import { Database } from 'bun:sqlite';
import { join } from 'path';

let db: any = null;

export function initDatabase(appPath: string) {
  const dbPath = join(appPath, 'data.db');
  db = new Database(dbPath, { create: true });

  // REDESIGN §2.5 — 동시 접근 내구성. WAL + busy_timeout 이 없으면 두 번째 writer 가
  // SQLITE_BUSY 로 즉시 실패하고, 그 예외가 복구 루프에 들어가 재시도 증폭으로 번진다.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');

  // 프록시 그룹 테이블 생성
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxy_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      max_browsers INTEGER DEFAULT 5,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 기본 그룹 생성 (없으면)
  db.exec(`
    INSERT OR IGNORE INTO proxy_groups (id, name, max_browsers) VALUES (1, '기본 그룹', 5)
  `);

  // 프록시 테이블 생성
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER DEFAULT 1,
      ip TEXT NOT NULL,
      port TEXT NOT NULL,
      username TEXT,
      password TEXT,
      status TEXT DEFAULT 'active',
      last_checked DATETIME,
      fail_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES proxy_groups(id)
    )
  `);

  // 기존 테이블에 group_id 컬럼 추가 (마이그레이션)
  try {
    db.exec(`ALTER TABLE proxies ADD COLUMN group_id INTEGER DEFAULT 1`);
    console.log('Added group_id column to proxies table');
  } catch {
    // 이미 컬럼이 존재하면 무시
  }

  // 브라우저 세션 테이블 생성
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      proxy_id INTEGER,
      status TEXT,
      current_url TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (proxy_id) REFERENCES proxies(id)
    )
  `);

  // 크롤링 로그 테이블 생성
  db.exec(`
    CREATE TABLE IF NOT EXISTS crawl_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      url TEXT,
      status TEXT,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES browser_sessions(id)
    )
  `);

  // 설정 테이블 생성
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // REDESIGN §2.1 — lease 소유권 컬럼 (마이그레이션).
  // owner 가 소유권의 유일한 진실이고 status 는 하위호환/가독용 파생값이다.
  for (const ddl of [
    'ALTER TABLE proxies ADD COLUMN owner TEXT',
    'ALTER TABLE proxies ADD COLUMN leased_at INTEGER',
  ]) {
    try {
      db.exec(ddl);
      console.log(`[DB] 마이그레이션 적용: ${ddl}`);
    } catch {
      // 이미 존재하면 무시
    }
  }
  // 획득 경로가 매번 스캔하지 않도록 인덱스 부여
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_proxies_lease ON proxies (group_id, status, owner, leased_at)',
  );

  console.log('Database initialized at:', dbPath);
}

// ==========================================
// Proxy Group CRUD
// ==========================================

export function getProxyGroups() {
  return db.prepare('SELECT * FROM proxy_groups ORDER BY id ASC').all();
}

export function addProxyGroup(name: string, maxBrowsers: number = 5) {
  const stmt = db.prepare(`
    INSERT INTO proxy_groups (name, max_browsers) VALUES (?, ?)
  `);
  return stmt.run(name, maxBrowsers);
}

export function updateProxyGroup(id: number, updates: { name?: string; max_browsers?: number }) {
  const fields = [];
  const values = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.max_browsers !== undefined) {
    fields.push('max_browsers = ?');
    values.push(updates.max_browsers);
  }

  if (fields.length === 0) return;

  values.push(id);
  const stmt = db.prepare(`UPDATE proxy_groups SET ${fields.join(', ')} WHERE id = ?`);
  return stmt.run(...values);
}

export function deleteProxyGroup(id: number) {
  // 기본 그룹(id=1)은 삭제 불가
  if (id === 1) {
    throw new Error('기본 그룹은 삭제할 수 없습니다.');
  }

  // 해당 그룹의 프록시들을 기본 그룹으로 이동
  db.prepare('UPDATE proxies SET group_id = 1 WHERE group_id = ?').run(id);

  // 그룹 삭제
  const stmt = db.prepare('DELETE FROM proxy_groups WHERE id = ?');
  return stmt.run(id);
}

export function getProxyGroupWithCount() {
  return db.prepare(`
    SELECT
      pg.*,
      COUNT(p.id) as proxy_count,
      SUM(CASE WHEN p.status = 'active' THEN 1 ELSE 0 END) as active_count,
      SUM(CASE WHEN p.status = 'dead' THEN 1 ELSE 0 END) as dead_count,
      SUM(CASE WHEN p.status = 'in_use' THEN 1 ELSE 0 END) as in_use_count
    FROM proxy_groups pg
    LEFT JOIN proxies p ON pg.id = p.group_id
    GROUP BY pg.id
    ORDER BY pg.id ASC
  `).all();
}

// ==========================================
// Lease 원장 (REDESIGN §2) — 소유권의 유일한 진실
// ==========================================

/** lease 획득 결과 행. bun:sqlite 는 named param 에 `$` 접두가 필요하므로 positional 을 쓴다. */
export interface LeaseRow {
  id: number;
  ip: string;
  port: string;
  username: string | null;
  password: string | null;
  group_id: number;
}

/**
 * 원자적 획득 (§2.2). 단일 UPDATE...RETURNING 이라 check-then-act 경쟁이 구조적으로 불가능하다.
 * ORDER BY 가 곧 쿨다운: 미사용(leased_at IS NULL) 우선, 그다음 가장 오래전 반납순(LRU).
 * 방금 차단된 IP 가 몇 픅 안에 다시 뽑히던 문제(positional index + reload)가 사라진다.
 * 고갈 시 undefined 를 반환한다(예외 아님).
 */
export function acquireProxyLease(owner: string, groupId: number, now: number): LeaseRow | undefined {
  const row = db
    .prepare(
      `UPDATE proxies SET status='in_use', owner=?1, leased_at=?2
       WHERE id = (
         SELECT id FROM proxies
         WHERE group_id=?3 AND status='active' AND owner IS NULL
         ORDER BY leased_at IS NULL DESC, leased_at ASC, id ASC
         LIMIT 1
       )
       RETURNING id, ip, port, username, password, group_id`,
    )
    .get(owner, now, groupId) as LeaseRow | null;
  return row ?? undefined;
}

/**
 * 소유권 검증 반납 (§2.3). owner 가 일치하지 않으면 아무것도 바꾸지 않고 false 를 반환한다.
 * 남의 살아있는 프록시를 해제하는 경로가 구조적으로 사라진다(모델 검증: 이 검증을 빼면 I1 이 깨짐).
 */
export function releaseProxyLease(proxyId: number, owner: string, now: number): boolean {
  const row = db
    .prepare(
      `UPDATE proxies SET status='active', owner=NULL, leased_at=?3
       WHERE id=?1 AND owner=?2
       RETURNING id`,
    )
    .get(proxyId, owner, now) as { id: number } | null;
  return row !== null;
}

/** 현재 lease 중인 행 (리컨실 대조용) */
export function getLeasedProxies() {
  return db
    .prepare(`SELECT id, group_id, owner, leased_at FROM proxies WHERE status='in_use' OR owner IS NOT NULL`)
    .all() as { id: number; group_id: number; owner: string | null; leased_at: number | null }[];
}

/** 고아 lease 회수 (§2.4). 호출자가 살아있는 (owner,proxyId) 쌍과 grace 로 판정한 id 만 넘긴다. */
export function reclaimProxyLeases(proxyIds: readonly number[], now: number): number {
  if (proxyIds.length === 0) return 0;
  const placeholders = proxyIds.map(() => '?').join(',');
  const stmt = db.prepare(
    `UPDATE proxies SET status='active', owner=NULL, leased_at=${now} WHERE id IN (${placeholders})`,
  );
  const result = stmt.run(...proxyIds);
  return typeof result.changes === 'number' ? result.changes : proxyIds.length;
}

/**
 * 부팅 시 이전 프로세스 잔재 회수 (§2.5).
 * 단일 인스턴스 락을 잡은 프로세스만 호출해야 한다 — 그렇지 않으면 살아있는 다른 인스턴스의
 * lease 를 파괴해 30 브라우저가 15 IP 를 공유하게 된다.
 */
export function reclaimAllLeases(now: number): number {
  const result = db
    .prepare(`UPDATE proxies SET status='active', owner=NULL, leased_at=?1 WHERE status='in_use' OR owner IS NOT NULL`)
    .run(now);
  return typeof result.changes === 'number' ? result.changes : 0;
}

// ==========================================
// Proxy CRUD
// ==========================================

export function getProxies() {
  return db.prepare('SELECT * FROM proxies ORDER BY group_id ASC, id DESC').all();
}

export function getProxiesByGroup(groupId: number) {
  return db.prepare('SELECT * FROM proxies WHERE group_id = ? ORDER BY id DESC').all(groupId);
}

export function addProxy(proxy: { group_id?: number; ip: string; port: string; username?: string; password?: string }) {
  // 컬럼 6개에 값 5개를 바인딩해 모든 호출이 `5 values for 6 columns` 로 실패했다.
  // (UI 의 프록시 단건 추가가 100% 깨져 있었음)
  const stmt = db.prepare(`
    INSERT INTO proxies (group_id, ip, port, username, password, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `);
  return stmt.run(
    proxy.group_id ?? 1,
    proxy.ip,
    proxy.port,
    proxy.username ?? '',
    proxy.password ?? '',
  );
}

export function bulkAddProxies(proxies: any[], groupId: number = 1) {
  const stmt = db.prepare(`
    INSERT INTO proxies (group_id, ip, port, username, password, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `);

  const transaction = db.transaction((proxiesToAdd: any[]) => {
    for (const proxy of proxiesToAdd) {
      stmt.run(groupId, proxy.ip, proxy.port, proxy.username || '', proxy.password || '');
    }
  });

  transaction(proxies);
}

export function updateProxyGroup_id(proxyId: number, groupId: number) {
  const stmt = db.prepare('UPDATE proxies SET group_id = ? WHERE id = ?');
  return stmt.run(groupId, proxyId);
}

export function deleteProxiesByGroup(groupId: number) {
  const stmt = db.prepare('DELETE FROM proxies WHERE group_id = ?');
  return stmt.run(groupId);
}

export function updateProxy(id: number, updates: any) {
  const fields = [];
  const values = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.last_checked !== undefined) {
    fields.push('last_checked = ?');
    values.push(updates.last_checked);
  }
  if (updates.fail_count !== undefined) {
    fields.push('fail_count = ?');
    values.push(updates.fail_count);
  }
  if (updates.success_count !== undefined) {
    fields.push('success_count = ?');
    values.push(updates.success_count);
  }

  if (fields.length === 0) return;

  values.push(id);
  const stmt = db.prepare(`UPDATE proxies SET ${fields.join(', ')} WHERE id = ?`);
  return stmt.run(...values);
}

export function deleteProxy(id: number) {
  const stmt = db.prepare('DELETE FROM proxies WHERE id = ?');
  return stmt.run(id);
}

export function deleteAllProxies() {
  const stmt = db.prepare('DELETE FROM proxies');
  return stmt.run();
}

// Settings CRUD
export function getSetting(key: string) {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const result = stmt.get(key);
  return result ? result.value : null;
}

export function setSetting(key: string, value: string) {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(key, value, value);
}

export function getAllSettings() {
  return db.prepare('SELECT key, value FROM settings').all();
}

export { db };
