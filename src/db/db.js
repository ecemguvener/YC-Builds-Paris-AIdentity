import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH || './data/payments.db';

// Ensure the parent directory exists.
const dir = path.dirname(DB_PATH);
if (dir && dir !== '.' && !fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** Run the schema migration. Idempotent — safe on every boot. */
export function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}

/** Seed demo agents so the Identity Hub has something to validate against. */
export function seedDemoAgents() {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO agents (agent_id, name, owner_user_id, email, phone, calendar, created_at)
    VALUES (@agent_id, @name, @owner_user_id, @email, @phone, @calendar, @created_at)
  `);
  const agents = [
    {
      agent_id: 'agent_123',
      name: 'Ada — Research Assistant',
      owner_user_id: 'user_123',
      email: 'ada@agents.example.com',
      phone: '+44 7000 000123',
      calendar: 'ada@calendar.example.com',
      created_at: now,
    },
    {
      agent_id: 'agent_456',
      name: 'Boyd — Ops Bot',
      owner_user_id: 'user_456',
      email: 'boyd@agents.example.com',
      phone: '+44 7000 000456',
      calendar: 'boyd@calendar.example.com',
      created_at: now,
    },
  ];
  const tx = db.transaction(() => agents.forEach((a) => insert.run(a)));
  tx();
}
