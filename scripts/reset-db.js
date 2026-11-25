/**
 * npm run db:reset - delete the local database and rebuild it from scratch.
 *
 * This is the only supported way to recover the demo agent tokens: they are shown
 * once at creation and only their digests are stored.
 */
import { existsSync, rmSync } from 'node:fs';
import { createApp } from '../src/app.js';

const dbPath = process.env.DB_PATH ?? 'data/agent-tickets.db';
const driver = process.env.DB_DRIVER ?? 'auto';

for (const suffix of ['', '-wal', '-shm']) {
  const target = `${dbPath}${suffix}`;
  if (existsSync(target)) {
    rmSync(target, { force: true });
    console.log(`[reset] removed ${target}`);
  }
}

const app = await createApp({ dbPath, driver, seed: true });
console.log(`[reset] rebuilt ${dbPath} (${app.driver}) with schema and demo agents`);
await app.close();
