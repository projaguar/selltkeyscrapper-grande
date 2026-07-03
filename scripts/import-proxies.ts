#!/usr/bin/env bun

import { join } from 'path';
import { readFileSync } from 'fs';
import { Database } from 'bun:sqlite';
import { DATA_DIR } from '../src/data-dir';

const DB_PATH = join(DATA_DIR, 'data.db');
const PROXY_FILE = join(process.cwd(), '_resource/프록시유동_모모아이피.txt');

interface Proxy {
  ip: string;
  port: string;
}

function parseProxyFile(filePath: string): Proxy[] {
  console.log('📄 Reading proxy file:', filePath);

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  const proxies: Proxy[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [ip, port] = trimmed.split(':');
    if (ip && port) {
      proxies.push({ ip, port });
    } else {
      console.warn(`⚠️  Invalid format: ${trimmed}`);
    }
  }

  return proxies;
}

function importProxies() {
  console.log('🚀 Starting proxy import...\n');

  // Parse proxy file
  const proxies = parseProxyFile(PROXY_FILE);
  console.log(`✅ Parsed ${proxies.length} proxies from file\n`);

  // Connect to database
  console.log('🗄️  Connecting to database:', DB_PATH);
  const db = new Database(DB_PATH, { create: true });

  // Prepare statement
  const stmt = db.prepare(`
    INSERT INTO proxies (ip, port, username, password, status)
    VALUES (?, ?, ?, ?, 'active')
  `);

  // Use transaction for bulk insert
  const transaction = db.transaction((proxiesToAdd: Proxy[]) => {
    for (const proxy of proxiesToAdd) {
      stmt.run(proxy.ip, proxy.port, '', '');
    }
  });

  console.log('💾 Importing proxies to database...');

  try {
    transaction(proxies);
    console.log(`✅ Successfully imported ${proxies.length} proxies`);

    // Show total count
    const totalCount = db.prepare('SELECT COUNT(*) as count FROM proxies').get() as { count: number };
    console.log(`📊 Total proxies in database: ${totalCount.count}`);
  } catch (error) {
    console.error('❌ Import failed:', error);
    throw error;
  } finally {
    db.close();
  }
}

try {
  importProxies();
} catch (error) {
  console.error('❌ Error:', error);
  process.exit(1);
}
