/**
 * Idempotent migration runner.
 *
 * The applied version lives in PRAGMA user_version, so the database itself is the
 * source of truth (no extra bookkeeping table). Each migration runs inside one
 * transaction: either the whole schema lands or none of it does.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS = [
  { version: 1, name: 'initial schema', file: 'schema.sql' },
];

function firstValue(row) {
  if (!row) return 0;
  const value = row.user_version !== undefined ? row.user_version : Object.values(row)[0];
  return Number(value ?? 0);
}

function readUserVersion(db) {
  // The pragma form is the documented one; the table-valued form
  // (pragma_user_version) is ordinary SQL and is used as a fallback because it is
  // accepted by every SQLite binding, including ones that refuse to prepare a bare
  // PRAGMA statement.
  try {
    return firstValue(db.prepare('PRAGMA user_version').get());
  } catch {
    return firstValue(db.prepare('SELECT * FROM pragma_user_version').get());
  }
}

export function migrate(db, { logger = console } = {}) {
  const before = readUserVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.version <= before) continue;
    const sql = readFileSync(join(HERE, migration.file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${Number(migration.version)}`);
    });
    logger.log?.(`[db] applied migration ${migration.version} (${migration.name})`);
  }

  const after = readUserVersion(db);
  return { before, after };
}
