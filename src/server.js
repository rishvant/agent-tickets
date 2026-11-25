/**
 * Entry point: `npm run dev` (or `node src/server.js`).
 *
 * Creates the database if missing, applies migrations, seeds three demo agents on
 * first run (tokens printed once), then serves the API and the static UI from one
 * port. Never logs tokens or headers.
 */
import { createApp } from './app.js';

const DEFAULT_PORT = 8787;

function formatLease(ms) {
  const minutes = ms / 60000;
  return Number.isInteger(minutes) ? `${minutes} min` : `${(ms / 1000).toFixed(1)} s`;
}

async function main() {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const dbPath = process.env.DB_PATH ?? 'data/agent-tickets.db';
  const driver = process.env.DB_DRIVER ?? 'auto';

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[fatal] invalid PORT "${process.env.PORT}"`);
    process.exitCode = 1;
    return;
  }

  let app;
  try {
    app = await createApp({ dbPath, driver, seed: process.env.SEED !== '0' });
  } catch (error) {
    console.error('');
    console.error('[fatal] could not start Agent Tickets');
    console.error(error?.message ?? String(error));
    console.error('');
    process.exitCode = 1;
    return;
  }

  const { server } = app;

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, resolve);
    });
  } catch (error) {
    console.error(`[fatal] could not listen on port ${port}: ${error?.message ?? error}`);
    await app.close();
    process.exitCode = 1;
    return;
  }

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  const base = `http://127.0.0.1:${actualPort}`;

  console.log('');
  console.log('Agent Tickets P0');
  console.log(`  ui       ${base}/`);
  console.log(`  board    ${base}/app.html`);
  console.log(`  health   ${base}/api/health`);
  console.log(`  storage  ${app.dbPath} (${app.driver}, WAL)`);
  console.log(`  lease    ${formatLease(app.leaseMs)}`);
  console.log(`  agents   ${app.seeded.filter((entry) => !entry.existed).length} seeded this run`);
  console.log('');

  const shutdown = async (signal) => {
    console.log(`[shutdown] ${signal}`);
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[fatal]', error?.stack ?? error);
  process.exitCode = 1;
});
