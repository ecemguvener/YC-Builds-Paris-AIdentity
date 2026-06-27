import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/payments.db';
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (fs.existsSync(f)) {
    fs.rmSync(f);
    console.log('removed', path.resolve(f));
  }
}
console.log('Database reset. It will be re-created and seeded on next start.');
