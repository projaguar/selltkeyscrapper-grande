import Database from 'better-sqlite3';
import { join } from 'path';

let db: any = null;

export function initDatabase(appPath: string) {
  const dbPath = join(appPath, 'data.db');
  db = new Database(dbPath);

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
// Proxy CRUD
// ==========================================

export function getProxies() {
  return db.prepare('SELECT * FROM proxies ORDER BY group_id ASC, id DESC').all();
}

export function getProxiesByGroup(groupId: number) {
  return db.prepare('SELECT * FROM proxies WHERE group_id = ? ORDER BY id DESC').all(groupId);
}

export function addProxy(proxy: any) {
  const stmt = db.prepare(`
    INSERT INTO proxies (group_id, ip, port, username, password, status)
    VALUES (?, ?, ?, ?, 'active')
  `);
  return stmt.run(proxy.group_id || 1, proxy.ip, proxy.port, proxy.username || '', proxy.password || '');
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
