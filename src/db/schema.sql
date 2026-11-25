-- Agent Tickets P0 schema (migration 1, applied by src/db/migrate.js).
--
-- Conventions:
--   * all timestamps are UTC ISO-8601 strings ("2026-11-25T04:00:00.000Z") so that
--     lexicographic comparison is chronological comparison;
--   * all identifiers are UUID strings except counters.id;
--   * the activity table is append-only and enforced by triggers, not just by
--     application convention.

CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'human')),
  role         TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('worker', 'dispatcher', 'viewer')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id               TEXT PRIMARY KEY,
  key              TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  priority         TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  state            TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'claimed', 'in_progress', 'blocked', 'done', 'cancelled')),
  created_by       TEXT NOT NULL REFERENCES agents (id),
  assignee_id      TEXT REFERENCES agents (id),
  lease_expires_at TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  result           TEXT,
  block_reason     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  closed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_cursor ON tickets (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_state ON tickets (state, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets (assignee_id, state);
CREATE INDEX IF NOT EXISTS idx_tickets_lease ON tickets (state, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets (priority);

CREATE TABLE IF NOT EXISTS assignments (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL REFERENCES tickets (id),
  agent_id    TEXT NOT NULL REFERENCES agents (id),
  assigned_by TEXT NOT NULL REFERENCES agents (id),
  assigned_at TEXT NOT NULL,
  released_at TEXT,
  reason      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_assignments_ticket ON assignments (ticket_id, assigned_at);
CREATE INDEX IF NOT EXISTS idx_assignments_open ON assignments (agent_id, released_at);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets (id),
  author_id  TEXT NOT NULL REFERENCES agents (id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS activity (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets (id),
  actor_id   TEXT REFERENCES agents (id),
  action     TEXT NOT NULL,
  from_state TEXT,
  to_state   TEXT,
  metadata   TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_ticket ON activity (ticket_id, created_at);

-- Audit trail is append-only. These triggers make the guarantee a property of the
-- database: any UPDATE or DELETE on activity aborts, whatever the caller intends.
CREATE TRIGGER IF NOT EXISTS activity_no_update
BEFORE UPDATE ON activity
BEGIN
  SELECT RAISE(ABORT, 'activity is append-only: UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS activity_no_delete
BEFORE DELETE ON activity
BEGIN
  SELECT RAISE(ABORT, 'activity is append-only: DELETE rejected');
END;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT NOT NULL REFERENCES agents (id),
  key           TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status        INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (agent_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys (created_at);
