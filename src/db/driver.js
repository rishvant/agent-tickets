/**
 * Driver selection.
 *
 * DB_DRIVER:
 *   auto              (default) try node:sqlite, fall back to better-sqlite3
 *   node:sqlite       built-in only, fail loudly if unavailable
 *   better-sqlite3    optional native dependency only
 *
 * If the built-in module needs a flag on this Node version, the failure is turned
 * into an actionable message instead of a bare "no such built-in module".
 */
import { createBetterSqlite3Adapter, createNodeSqliteAdapter } from './sqlite.js';

export const DRIVER_CHOICES = ['auto', 'node:sqlite', 'better-sqlite3'];

export const FLAG_HINT = [
  'node:sqlite is not available in this Node build.',
  '  - Node 22.5 through 23.x ship it behind the --experimental-sqlite flag.',
  '  - Node 24+ ships it unflagged.',
  '',
  'Fix with one of:',
  '  1) node --experimental-sqlite src/server.js            (no dependencies)',
  '  2) npm install better-sqlite3 && DB_DRIVER=better-sqlite3 node src/server.js',
].join('\n');

export class DriverUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriverUnavailableError';
  }
}

function isMissingBuiltinModule(error) {
  if (!error) return false;
  if (error.code === 'ERR_UNKNOWN_BUILTIN_MODULE') return true;
  const message = String(error.message ?? '');
  return /no such built-in module/i.test(message) || /cannot find module 'node:sqlite'/i.test(message);
}

export async function openDatabase({ dbPath, driver = 'auto', logger = console } = {}) {
  const requested = String(driver ?? 'auto').trim().toLowerCase();
  if (!DRIVER_CHOICES.includes(requested)) {
    throw new DriverUnavailableError(
      `unknown DB_DRIVER "${driver}" (expected one of: ${DRIVER_CHOICES.join(', ')})`,
    );
  }

  if (requested === 'better-sqlite3') {
    return createBetterSqlite3Adapter(dbPath, { logger });
  }

  if (requested === 'node:sqlite') {
    try {
      return await createNodeSqliteAdapter(dbPath, { logger });
    } catch (error) {
      if (isMissingBuiltinModule(error)) throw new DriverUnavailableError(FLAG_HINT);
      throw error;
    }
  }

  // auto
  try {
    return await createNodeSqliteAdapter(dbPath, { logger });
  } catch (error) {
    if (!isMissingBuiltinModule(error)) throw error;
    logger.warn?.('[db] node:sqlite unavailable, trying better-sqlite3');
    try {
      return await createBetterSqlite3Adapter(dbPath, { logger });
    } catch (fallbackError) {
      throw new DriverUnavailableError(`${FLAG_HINT}\n\n(better-sqlite3 fallback failed too: ${fallbackError.message})`);
    }
  }
}
