/**
 * SQLite adapters.
 *
 * Two implementations, one interface, so the rest of the application never
 * imports a driver directly:
 *
 *   node:sqlite      built into Node (22.5+ behind --experimental-sqlite, 24+ unflagged)
 *   better-sqlite3   optional dependency, only used when DB_DRIVER=better-sqlite3
 *
 * The repository itself has zero dependencies. better-sqlite3 is never installed
 * by `npm install` here; it is an escape hatch for machines whose Node lacks
 * node:sqlite. Both are loaded lazily so neither is required at parse time.
 *
 * Interface (see src/db/driver.js):
 *   prepare(sql) -> { run(...p) => { changes, lastInsertRowid }, get(...p), all(...p) }
 *   exec(sql)
 *   transaction(fn)   fn MUST be synchronous
 *   close()
 *   name
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PRAGMAS = ['PRAGMA busy_timeout = 5000', 'PRAGMA foreign_keys = ON'];

class SqliteAdapter {
  constructor(db, name, logger) {
    this.db = db;
    this.name = name;
    this.logger = logger;
    this.inTransaction = false;
    this.#applyPragmas();
  }

  #applyPragmas() {
    for (const pragma of PRAGMAS) {
      try {
        this.db.exec(pragma);
      } catch (error) {
        this.logger.warn?.(`[db] could not apply "${pragma}": ${error.message}`);
      }
    }
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch (error) {
      // WAL can be unavailable on exotic filesystems; correctness does not depend on it.
      this.logger.warn?.(`[db] could not enable WAL: ${error.message}`);
    }
  }

  prepare(sql) {
    const statement = this.db.prepare(sql);
    return {
      run: (...params) => {
        const result = statement.run(...params) ?? {};
        return {
          changes: Number(result.changes ?? 0),
          lastInsertRowid: Number(result.lastInsertRowid ?? 0),
        };
      },
      get: (...params) => statement.get(...params) ?? undefined,
      all: (...params) => statement.all(...params) ?? [],
    };
  }

  exec(sql) {
    this.db.exec(sql);
  }

  /**
   * BEGIN IMMEDIATE / COMMIT around a *synchronous* function. Nested calls throw
   * rather than silently creating savepoints, so the code path that owns the
   * transaction is always obvious.
   */
  transaction(fn) {
    if (this.inTransaction) {
      throw new Error('nested db.transaction() is not supported: keep transaction bodies flat');
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new Error('db.transaction(fn) requires a synchronous fn');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The original error matters more than a rollback failure.
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      // closing an already-closed handle is not an error worth surfacing
    }
  }
}

function ensureParentDirectory(dbPath) {
  if (dbPath && dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
}

export async function createNodeSqliteAdapter(dbPath, { logger = console } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  ensureParentDirectory(dbPath);
  const db = new DatabaseSync(dbPath);
  return new SqliteAdapter(db, 'node:sqlite', logger);
}

export async function createBetterSqlite3Adapter(dbPath, { logger = console } = {}) {
  let module;
  try {
    module = await import('better-sqlite3');
  } catch (error) {
    const wrapped = new Error(
      'better-sqlite3 is not installed. This repository ships zero dependencies, so install it explicitly: npm install better-sqlite3',
    );
    wrapped.cause = error;
    throw wrapped;
  }
  const Database = module.default ?? module;
  ensureParentDirectory(dbPath);
  const db = new Database(dbPath);
  return new SqliteAdapter(db, 'better-sqlite3', logger);
}
