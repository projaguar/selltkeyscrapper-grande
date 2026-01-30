#!/usr/bin/env tsx

import { join } from 'path';
import Database from 'better-sqlite3';
import { homedir } from 'os';

const DB_PATH = join(homedir(), 'Library/Application Support/scrapper/data.db');

function deleteAllProxies() {
  console.log('🗑️  Connecting to database:', DB_PATH);

  const db = new Database(DB_PATH);

  // Get count before deletion
  const countBefore = db.prepare('SELECT COUNT(*) as count FROM proxies').get() as { count: number };

  if (countBefore.count === 0) {
    console.log('ℹ️  No proxies found in database.');
    db.close();
    return;
  }

  console.log(`📊 Found ${countBefore.count} proxies in database`);
  console.log('🗑️  Deleting all proxies...');

  const result = db.prepare('DELETE FROM proxies').run();

  console.log(`✅ Successfully deleted ${result.changes} proxies`);

  db.close();
}

try {
  deleteAllProxies();
} catch (error) {
  console.error('❌ Error:', error);
  process.exit(1);
}
