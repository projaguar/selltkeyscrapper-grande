import Database from 'better-sqlite3';
import { join } from 'path';

let db: any = null;

export function initDatabase(appPath: string) {
  const dbPath = join(appPath, 'data.db');
  db = new Database(dbPath);

  // 프록시 테이블 생성
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      port TEXT NOT NULL,
      username TEXT,
      password TEXT,
      status TEXT DEFAULT 'active',
      last_checked DATETIME,
      fail_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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

// Proxy CRUD
export function getProxies() {
  return db.prepare('SELECT * FROM proxies ORDER BY id DESC').all();
}

export function addProxy(proxy: any) {
  const stmt = db.prepare(`
    INSERT INTO proxies (ip, port, username, password, status)
    VALUES (?, ?, ?, ?, 'active')
  `);
  return stmt.run(proxy.ip, proxy.port, proxy.username || '', proxy.password || '');
}

export function bulkAddProxies(proxies: any[]) {
  const stmt = db.prepare(`
    INSERT INTO proxies (ip, port, username, password, status)
    VALUES (?, ?, ?, ?, 'active')
  `);

  const transaction = db.transaction((proxiesToAdd: any[]) => {
    for (const proxy of proxiesToAdd) {
      stmt.run(proxy.ip, proxy.port, proxy.username || '', proxy.password || '');
    }
  });

  transaction(proxies);
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
