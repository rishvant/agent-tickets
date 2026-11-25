/**
 * Agent registry: registration, token hashing, authentication.
 *
 * A raw token is returned exactly once at registration and never stored: only its
 * SHA-256 digest is persisted. Lookup is by digest (indexed), and the comparison
 * against the stored digest is timing-safe as a second line of defence.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError, ERROR_CODES } from '../http/responses.js';

export const AGENT_KINDS = Object.freeze(['agent', 'human']);
export const AGENT_ROLES = Object.freeze(['worker', 'dispatcher', 'viewer']);
export const NAME_LIMIT = 80;
export const DESCRIPTION_LIMIT = 500;

const TOKEN_PREFIX = 'at_';
// Explicit column list everywhere: token_hash must never reach a response.
const PUBLIC_COLUMNS = 'id, name, description, kind, role, status, created_at, last_seen_at';

export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function generateToken() {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
}

/** Constant-time comparison of two hex digests. */
export function safeCompareHex(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cleanName(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, '"name" is required and must be a non-empty string');
  }
  const name = value.trim();
  if (name.length > NAME_LIMIT) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `"name" must be at most ${NAME_LIMIT} characters`);
  }
  return name;
}

function cleanDescription(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, '"description" must be a string');
  }
  if (value.length > DESCRIPTION_LIMIT) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `"description" must be at most ${DESCRIPTION_LIMIT} characters`);
  }
  return value;
}

function cleanEnum(value, field, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `"${field}" must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

export function registerAgent(db, input = {}) {
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  const kind = cleanEnum(input.kind, 'kind', AGENT_KINDS, 'agent');
  const role = cleanEnum(input.role, 'role', AGENT_ROLES, 'worker');

  if (db.prepare('SELECT id FROM agents WHERE name = ?').get(name)) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `agent name "${name}" is already taken`);
  }

  const token = generateToken();
  const agentId = randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO agents (id, name, description, kind, role, status, token_hash, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
  ).run(agentId, name, description, kind, role, hashToken(token), createdAt);

  return { agent: getAgentPublic(db, agentId), token };
}

export function getAgentPublic(db, agentId) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM agents WHERE id = ?`).get(agentId) ?? null;
}

export function listAgents(db) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM agents ORDER BY created_at ASC, name ASC`).all();
}

/** Returns the agent row (without token_hash) or null. */
export function authenticate(db, token) {
  if (typeof token !== 'string' || token.length < 16) return null;

  const digest = hashToken(token);
  const row = db.prepare('SELECT * FROM agents WHERE token_hash = ?').get(digest);
  if (!row) return null;
  if (!safeCompareHex(row.token_hash, digest)) return null;
  if (row.status !== 'active') return null;

  return getAgentPublic(db, row.id);
}

export function touchAgent(db, agentId, at = new Date().toISOString()) {
  db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(at, agentId);
}

export function countActiveTickets(db, agentId) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS total FROM tickets WHERE assignee_id = ? AND state IN ('claimed', 'in_progress', 'blocked')",
    )
    .get(agentId);
  return Number(row?.total ?? 0);
}
