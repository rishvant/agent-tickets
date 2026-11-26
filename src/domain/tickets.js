/**
 * Ticket domain: lifecycle, atomic transitions, leases, audit trail.
 *
 * Design rules that the rest of the code relies on:
 *   * every exported function is SYNCHRONOUS and does not open a transaction;
 *     the route layer wraps a call in db.transaction() so the state change, the
 *     assignment row and exactly one activity row commit together;
 *   * state changes use conditional UPDATEs and check `changes === 1`, so two
 *     callers can never both win;
 *   * expired leases are resolved lazily and deterministically (on read and before
 *     every mutation), never by a background timer, so tests can force the clock
 *     by writing lease_expires_at directly.
 */
import { randomUUID } from 'node:crypto';
import { ApiError, ERROR_CODES } from '../http/responses.js';
import { getAgentPublic } from './agents.js';

export const STATES = Object.freeze(['open', 'claimed', 'in_progress', 'blocked', 'done', 'cancelled']);
export const TERMINAL_STATES = Object.freeze(['done', 'cancelled']);
export const HELD_STATES = Object.freeze(['claimed', 'in_progress', 'blocked']);
// Lease expiry only applies to states where the holder is actively working. A
// `blocked` ticket is deliberately exempt: waiting on input is not a time-bounded
// activity, and reaping it would take the ticket away from a holder that is still
// legitimately responsible for it. Blocked tickets leave that state via /start,
// /assign or /cancel, all of which remain available.
export const EXPIRABLE_STATES = Object.freeze(['claimed', 'in_progress']);
export const ASSIGNABLE_STATES = Object.freeze(['open', 'claimed', 'blocked']);
export const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

export const LIMITS = Object.freeze({
  title: 200,
  body: 20000,
  result: 10000,
  reason: 2000,
  comment: 10000,
});

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;
export const ACTIVITY_PAGE_SIZE = 50;

let leaseMs = DEFAULT_LEASE_MS;

export function configureTickets(options = {}) {
  if (options.leaseMs !== undefined) {
    const value = Number(options.leaseMs);
    if (!Number.isFinite(value) || value <= 0) throw new Error('leaseMs must be a positive number of milliseconds');
    leaseMs = value;
  }
  return { leaseMs };
}

export function currentLeaseMs() {
  return leaseMs;
}

/* ------------------------------------------------------------------ helpers */

function nowIso(at = Date.now()) {
  return new Date(at).toISOString();
}

function leaseExpiryIso() {
  return new Date(Date.now() + leaseMs).toISOString();
}

function newId() {
  return randomUUID();
}

function cleanText(value, field, { max, required = false }) {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `"${field}" is required`);
    return null;
  }
  if (typeof value !== 'string') {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `"${field}" must be a string`);
  }
  const text = value.trim();
  if (required && text.length === 0) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `"${field}" must not be empty`);
  }
  if (text.length > max) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `"${field}" must be at most ${max} characters`);
  }
  return text;
}

function requireTicket(db, ticketId) {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!row) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'ticket not found');
  return row;
}

export function getTicketRow(db, ticketId) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) ?? null;
}

function isTerminal(ticket) {
  return TERMINAL_STATES.includes(ticket.state);
}

function assertNotTerminal(ticket) {
  if (isTerminal(ticket)) {
    throw new ApiError(409, ERROR_CODES.TICKET_CLOSED, `ticket is ${ticket.state} and cannot be changed`);
  }
}

function assertAssignee(ticket, actor) {
  if (ticket.assignee_id !== actor.id) {
    throw new ApiError(403, ERROR_CODES.NOT_ASSIGNEE, 'only the agent holding this ticket may do that');
  }
}

export function recordActivity(db, { ticketId, actorId = null, action, fromState = null, toState = null, metadata = {} }) {
  db.prepare(
    `INSERT INTO activity (id, ticket_id, actor_id, action, from_state, to_state, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), ticketId, actorId, action, fromState, toState, JSON.stringify(metadata), nowIso());
}

function openAssignment(db, { ticketId, agentId, assignedBy, reason = '' }) {
  db.prepare(
    `INSERT INTO assignments (id, ticket_id, agent_id, assigned_by, assigned_at, released_at, reason)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(newId(), ticketId, agentId, assignedBy, nowIso(), reason);
}

function releaseAssignments(db, { ticketId }) {
  db.prepare('UPDATE assignments SET released_at = ? WHERE ticket_id = ? AND released_at IS NULL').run(nowIso(), ticketId);
}

export function hasActiveTicket(db, agentId, excludeTicketId = null) {
  const row = db
    .prepare(
      `SELECT id FROM tickets
       WHERE assignee_id = ? AND state IN ('claimed', 'in_progress', 'blocked') AND id != ?
       LIMIT 1`,
    )
    .get(agentId, excludeTicketId ?? '');
  return Boolean(row);
}

/** True when the ticket is expirable and its lease is in the past. */
function isLeaseExpired(ticket, at = nowIso()) {
  return Boolean(
    ticket &&
      ticket.lease_expires_at &&
      EXPIRABLE_STATES.includes(ticket.state) &&
      ticket.lease_expires_at <= at,
  );
}

/**
 * Adds a computed `lease_expired` flag to a ticket row for API responses.
 *
 * Reads no longer sweep (that would take BEGIN IMMEDIATE on every GET), so a GET can
 * legitimately return a ticket whose lease has lapsed but which no mutation has reaped
 * yet. The flag makes that state visible instead of silently reporting a dead lease as
 * if it were live. It is derived, never stored.
 */
export function decorateTicket(ticket, at = nowIso()) {
  if (!ticket) return ticket;
  return { ...ticket, lease_expired: isLeaseExpired(ticket, at) };
}

/**
 * True when this actor lost the ticket because its own lease expired: the ticket is
 * back in the queue and the most recent lease_expired row names this agent. Used to
 * answer 409 LEASE_EXPIRED instead of a generic INVALID_TRANSITION.
 */
function leaseWasLostBy(db, ticket, actorId) {
  if (!ticket || ticket.state !== 'open') return false;
  const row = db
    .prepare("SELECT metadata FROM activity WHERE ticket_id = ? AND action = 'lease_expired' ORDER BY rowid DESC LIMIT 1")
    .get(ticket.id);
  if (!row) return false;
  try {
    const metadata = JSON.parse(row.metadata);
    return metadata.previous_assignee_id === actorId;
  } catch {
    return false;
  }
}

/** 409 for a state that does not allow the action; LEASE_EXPIRED when the caller's own lease lapsed. */
function stateError(db, ticket, actor, message) {
  if (leaseWasLostBy(db, ticket, actor.id)) {
    return new ApiError(
      409,
      ERROR_CODES.LEASE_EXPIRED,
      'your lease on this ticket expired and the ticket is back in the queue',
    );
  }
  return new ApiError(409, ERROR_CODES.INVALID_TRANSITION, message);
}

/**
 * Every state-changing UPDATE is conditional on the state it was read in, so the
 * driver must report exactly one row. Anything else means the ticket moved under us:
 * reject with 409 *before* writing an activity row, so a rejected action can never
 * leave a duplicate audit entry.
 */
function assertSingleRow(result, action) {
  if (result.changes !== 1) {
    throw new ApiError(409, ERROR_CODES.INVALID_TRANSITION, `ticket changed while trying to ${action}; retry`);
  }
}

/* ------------------------------------------------------- lease expiry (lazy) */

/**
 * Returns an expired ticket to the queue: state open, assignee cleared, one
 * lease_expired activity row. Returns true when it actually expired something.
 */
function expireLease(db, ticketId, at = nowIso()) {
  const ticket = getTicketRow(db, ticketId);
  if (!ticket) return false;
  if (!EXPIRABLE_STATES.includes(ticket.state)) return false;
  if (!ticket.lease_expires_at) return false;
  if (ticket.lease_expires_at > at) return false;

  const result = db
    .prepare(
      `UPDATE tickets
          SET state = 'open', assignee_id = NULL, lease_expires_at = NULL, block_reason = NULL,
              version = version + 1, updated_at = ?
        WHERE id = ? AND state = ? AND lease_expires_at <= ?`,
    )
    .run(at, ticket.id, ticket.state, at);

  if (result.changes !== 1) return false;

  releaseAssignments(db, { ticketId: ticket.id });
  recordActivity(db, {
    ticketId: ticket.id,
    actorId: null,
    action: 'lease_expired',
    fromState: ticket.state,
    toState: 'open',
    metadata: {
      previous_assignee_id: ticket.assignee_id,
      expired_lease: ticket.lease_expires_at,
    },
  });
  return true;
}

/**
 * Resolves every expired lease (bounded sweep). Safe to call on reads and before
 * mutations; idempotent because an expired ticket no longer has a lease.
 */
export function sweepExpiredLeases(db, { now = nowIso(), limit = 50 } = {}) {
  const rows = db
    .prepare(
      `SELECT id FROM tickets
        WHERE state IN ('claimed', 'in_progress')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
        ORDER BY lease_expires_at ASC
        LIMIT ?`,
    )
    .all(now, limit);

  let expired = 0;
  for (const row of rows) {
    if (expireLease(db, row.id, now)) expired += 1;
  }
  return expired;
}

/**
 * Runs the sweep in its OWN transaction and commits it before the caller does any
 * further work.
 *
 * Rationale: if the sweep shared the caller's transaction, a request that expires a
 * lease and then fails (a stale holder's /complete returning 409) would roll the
 * expiry back, leaving the ticket held by a dead lease. Expiry is a fact about the
 * clock, not about the caller's success, so it must be durable on its own.
 *
 * This is the one deliberate exception to the "domain functions never open a
 * transaction" rule; it exists precisely to make expiries survive a later rollback.
 */
export function sweepExpiredLeasesCommitted(db, options) {
  return db.transaction(() => sweepExpiredLeases(db, options));
}

/* ------------------------------------------------------------------- create */

export function createTicket(db, { actor, title, body, priority } = {}) {
  const cleanTitle = cleanText(title, 'title', { max: LIMITS.title, required: true });
  const cleanBody = cleanText(body, 'body', { max: LIMITS.body }) ?? '';
  const cleanPriority = cleanText(priority, 'priority', { max: 20 }) ?? 'normal';
  if (!PRIORITIES.includes(cleanPriority)) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `"priority" must be one of: ${PRIORITIES.join(', ')}`);
  }

  db.prepare('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT (name) DO NOTHING').run('ticket');
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run('ticket');
  const counter = db.prepare('SELECT value FROM counters WHERE name = ?').get('ticket');
  const key = `TKT-${Number(counter?.value ?? 0)}`;

  const ticketId = newId();
  const timestamp = nowIso();

  db.prepare(
    `INSERT INTO tickets (id, key, title, body, priority, state, created_by, assignee_id,
                          lease_expires_at, version, result, block_reason, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, NULL, 1, NULL, NULL, ?, ?, NULL)`,
  ).run(ticketId, key, cleanTitle, cleanBody, cleanPriority, actor.id, timestamp, timestamp);

  recordActivity(db, {
    ticketId,
    actorId: actor.id,
    action: 'created',
    fromState: null,
    toState: 'open',
    metadata: { key },
  });

  return decorateTicket(requireTicket(db, ticketId));
}

/* --------------------------------------------------------------------- read */

function normaliseLimit(limit) {
  if (limit === undefined || limit === null || limit === '') return DEFAULT_PAGE_SIZE;
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, '"limit" must be a positive integer');
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string') {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, '"cursor" must be a string');
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.created_at !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('malformed cursor payload');
    }
    return { created_at: parsed.created_at, id: parsed.id };
  } catch {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, '"cursor" is not a valid pagination cursor');
  }
}

export function listTickets(db, { state, assigneeId, priority, limit, cursor } = {}) {
  const clauses = [];
  const params = [];

  if (state !== undefined && state !== null && state !== '') {
    if (typeof state !== 'string' || !STATES.includes(state)) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `"state" must be one of: ${STATES.join(', ')}`);
    }
    clauses.push('state = ?');
    params.push(state);
  }

  if (priority !== undefined && priority !== null && priority !== '') {
    if (typeof priority !== 'string' || !PRIORITIES.includes(priority)) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `"priority" must be one of: ${PRIORITIES.join(', ')}`);
    }
    clauses.push('priority = ?');
    params.push(priority);
  }

  if (assigneeId !== undefined && assigneeId !== null && assigneeId !== '') {
    clauses.push('assignee_id = ?');
    params.push(String(assigneeId));
  }

  const pageSize = normaliseLimit(limit);
  const decoded = decodeCursor(cursor);
  if (decoded) {
    clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(decoded.created_at, decoded.created_at, decoded.id);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM tickets ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, pageSize + 1);

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null;

  return { tickets: page.map((row) => decorateTicket(row)), limit: pageSize, next_cursor: nextCursor };
}

export function listActivity(db, { ticketId, limit = ACTIVITY_PAGE_SIZE } = {}) {
  const rows = db
    .prepare('SELECT * FROM activity WHERE ticket_id = ? ORDER BY rowid DESC LIMIT ?')
    .all(ticketId, limit);
  // Chronological order reads better for a human; the query limits to the newest rows.
  return rows.reverse();
}

export function listComments(db, { ticketId } = {}) {
  return db.prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY rowid ASC').all(ticketId);
}

export function getTicketDetail(db, { ticketId, activityLimit = ACTIVITY_PAGE_SIZE } = {}) {
  const ticket = requireTicket(db, ticketId);
  return {
    ticket: decorateTicket(ticket),
    comments: listComments(db, { ticketId }),
    activity: listActivity(db, { ticketId, limit: activityLimit }),
  };
}

/* -------------------------------------------------------------------- patch */

export function patchTicket(db, { ticketId, actor, patch = {}, version } = {}) {
  const ticket = requireTicket(db, ticketId);
  assertNotTerminal(ticket);
  if (ticket.state !== 'open') {
    throw new ApiError(409, ERROR_CODES.INVALID_TRANSITION, `ticket is ${ticket.state}; only an open ticket can be edited`);
  }
  if (ticket.created_by !== actor.id) {
    throw new ApiError(403, ERROR_CODES.FORBIDDEN, 'only the agent that created this ticket may edit it');
  }
  if (version === undefined || version === null || version === '') {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, '"version" is required to edit a ticket');
  }
  const versionNumber = Number(version);
  if (!Number.isInteger(versionNumber)) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, '"version" must be an integer');
  }
  if (versionNumber !== Number(ticket.version)) {
    throw new ApiError(
      409,
      ERROR_CODES.VERSION_CONFLICT,
      `version mismatch: ticket is at version ${ticket.version}`,
    );
  }

  const fields = [];
  const values = [];
  const changed = [];

  if (patch.title !== undefined) {
    fields.push('title = ?');
    values.push(cleanText(patch.title, 'title', { max: LIMITS.title, required: true }));
    changed.push('title');
  }
  if (patch.body !== undefined) {
    fields.push('body = ?');
    values.push(cleanText(patch.body, 'body', { max: LIMITS.body }) ?? '');
    changed.push('body');
  }
  if (patch.priority !== undefined) {
    const priority = cleanText(patch.priority, 'priority', { max: 20, required: true });
    if (!PRIORITIES.includes(priority)) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `"priority" must be one of: ${PRIORITIES.join(', ')}`);
    }
    fields.push('priority = ?');
    values.push(priority);
    changed.push('priority');
  }

  if (fields.length === 0) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'provide at least one of: title, body, priority');
  }

  const timestamp = nowIso();
  const result = db
    .prepare(
      `UPDATE tickets SET ${fields.join(', ')}, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`,
    )
    .run(...values, timestamp, ticketId, Number(ticket.version));

  if (result.changes !== 1) {
    throw new ApiError(409, ERROR_CODES.VERSION_CONFLICT, 'ticket changed while you were editing it; re-read and retry');
  }

  recordActivity(db, {
    ticketId,
    actorId: actor.id,
    action: 'edited',
    fromState: ticket.state,
    toState: ticket.state,
    metadata: { fields: changed },
  });

  return decorateTicket(requireTicket(db, ticketId));
}

/* -------------------------------------------------------------- transitions */

/**
 * Heartbeat: the current holder extends its own lease.
 *
 * Why this exists: a fixed 15-minute lease means any task that legitimately takes
 * longer is force-released, and its holder can then never finish it (it gets a 409).
 * Renewal lets a working agent keep a ticket for as long as it is actually working on
 * it, while still guaranteeing that a dead holder releases its ticket.
 *
 * Ordering matters for the stale-holder case: the caller sweeps expired leases before
 * this runs, so a holder whose lease already lapsed finds the ticket back in `open`
 * and gets 409 INVALID_TRANSITION - the same treatment every other stale-holder action
 * gets. A live ticket held by somebody else is a plain 403 NOT_ASSIGNEE, matching
 * /start, /complete and /block.
 */
export function renewLease(db, { ticketId, actor } = {}) {
  const ticket = requireTicket(db, ticketId);
  assertNotTerminal(ticket);

  if (!HELD_STATES.includes(ticket.state)) {
    throw stateError(db, ticket, actor, `cannot renew the lease of a ticket in state "${ticket.state}"`);
  }
  assertAssignee(ticket, actor);

  const timestamp = nowIso();
  const lease = leaseExpiryIso();

  const result = db
    .prepare(
      `UPDATE tickets
          SET lease_expires_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND assignee_id = ? AND state = ?`,
    )
    .run(lease, timestamp, ticket.id, actor.id, ticket.state);

  if (result.changes !== 1) {
    throw new ApiError(409, ERROR_CODES.INVALID_TRANSITION, 'ticket changed while renewing the lease; retry');
  }

  recordActivity(db, {
    ticketId: ticket.id,
    actorId: actor.id,
    action: 'lease_renewed',
    fromState: ticket.state,
    toState: ticket.state,
    metadata: { previous_lease_expires_at: ticket.lease_expires_at, lease_expires_at: lease },
  });

  return decorateTicket(requireTicket(db, ticket.id));
}

export function claimTicket(db, { ticketId, actor } = {}) {
  const ticket = requireTicket(db, ticketId);
  assertNotTerminal(ticket);
  if (ticket.state !== 'open') {
    throw new ApiError(409, ERROR_CODES.TICKET_ALREADY_CLAIMED, 'ticket is not open');
  }
  if (hasActiveTicket(db, actor.id, ticket.id)) {
    throw new ApiError(409, ERROR_CODES.AGENT_BUSY, 'agent already holds an active ticket');
  }

  const timestamp = nowIso();
  const lease = leaseExpiryIso();
  const result = db
    .prepare(
      `UPDATE tickets
          SET state = 'claimed', assignee_id = ?, lease_expires_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND state = 'open'`,
    )
    .run(actor.id, lease, timestamp, ticket.id);

  if (result.changes !== 1) {
    throw new ApiError(409, ERROR_CODES.TICKET_ALREADY_CLAIMED, 'another agent claimed this ticket first');
  }

  openAssignment(db, { ticketId: ticket.id, agentId: actor.id, assignedBy: actor.id, reason: 'claimed' });
  recordActivity(db, {
    ticketId: ticket.id,
    actorId: actor.id,
    action: 'claimed',
    fromState: 'open',
    toState: 'claimed',
    metadata: { lease_expires_at: lease },
  });

  return decorateTicket(requireTicket(db, ticket.id));
}

export function assignTicket(db, { ticketId, actor, assigneeId } = {}) {
  const ticket = requireTicket(db, ticketId);
  assertNotTerminal(ticket);
  if (ticket.state === 'in_progress') {
    throw new ApiError(
      409,
      ERROR_CODES.TICKET_IN_PROGRESS,
      'ticket is in progress; block or cancel it before reassigning',
    );
  }
  if (!ASSIGNABLE_STATES.includes(ticket.state)) {
    throw new ApiError(409, ERROR_CODES.INVALID_TRANSITION, `cannot assign a ticket in state "${ticket.state}"`);
  }

  if (typeof assigneeId !== 'string' || assigneeId.trim().length === 0) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, '"assignee_id" is required');
  }
  const targetId = assigneeId.trim();
  if (targetId === actor.id) {
    throw new ApiError(409, ERROR_CODES.SELF_ASSIGNMENT, 'assign the ticket to another agent; claim it instead');
  }

  const target = getAgentPublic(db, targetId);
  if (!target) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, '"assignee_id" does not reference a known agent');
  }
  if (target.status !== 'active') {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'assignee is not an active agent');
  }
  if (hasActiveTicket(db, target.id, ticket.id)) {
    throw new ApiError(409, ERROR_CODES.AGENT_BUSY, 'assignee already holds an active ticket');
  }

  const timestamp = nowIso();
  const lease = leaseExpiryIso();
  const result = db
    .prepare(
      `UPDATE tickets
          SET state = 'claimed', assignee_id = ?, lease_expires_at = ?, block_reason = NULL,
              version = version + 1, updated_at = ?
        WHERE id = ? AND state = ?`,
    )
    .run(target.id, lease, timestamp, ticket.id, ticket.state);

  if (result.changes !== 1) {
    throw new ApiError(409, ERROR_CODES.INVALID_TRANSITION, 'ticket changed while assigning it; retry');
  }

  releaseAssignments(db, { ticketId: ticket.id });
  openAssignment(db, { ticketId: ticket.id, agentId: target.id, assignedBy: actor.id, reason: 'assigned' });
  recordActivity(db, {
    ticketId: ticket.id,
    actorId: actor.id,
    action: 'assigned',
    fromState: ticket.state,
    toState: 'claimed',
    metadata: { assignee_id: target.id, previous_assignee_id: ticket.assignee_id },
  });

  return decorateTicket(requireTicket(db, ticket.id));
}

export function startTicket(db, { ticketId, actor } = {}) {
  const ticket = requireTicket(db, ticketId);
  assertNotTerminal(ticket);
  if (!['claimed', 'blocked'].includes(ticket.state)) {
    throw stateError(db, ticket, actor, `cannot start a ticket in state "${ticket.state}"`);
  }
  assertAssignee(ticket, actor);

  const timestamp = nowIso();
  const lease = leaseExpiryIso();
  const result = db.prepare(
    `UPDATE tickets
        SET state = 'in_progress', block_reason = NULL, lease_expires_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND state = ?`,
  ).run(lease, timestamp, ticket.id, ticket.state);
  assertSingleRow(result, 'start the ticket');

  recordActivity(db, {
    ticketId: ticket.id,
    actorId: actor.id,
    action: 'started',
    fromState: ticket.state,
    toState: 'in_progress',
    metadata: { lease_expires_at: lease },
  });

  return decorateTicket(requireTicket(db, ticket.id));
}

export function completeTicket(db, { ticketId, actor, result: resultText } = {}) {
  const ticket = requireTicket(db, ticketId);
  assertNotTerminal(ticket);
  if (ticket.state !== 'in_progress') {
    throw stateError(db, ticket, actor, `cannot complete a ticket in state "${ticket.state}"`);
  }
  assertAssignee(ticket, actor);

  const result = cleanText(resultText, 'result', { max: LIMITS.result, required: true });
  const timestamp = nowIso();

  const updated = db.prepare(
    `UPDATE tickets
        SET state = 'done', result = ?, lease_expires_at = NULL, closed_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND state = 'in_progress'`,
  ).run(result, timestamp, timestamp, ticket.id);
  assertSingleRow(updated, 'complete the ticket');

  releaseAssignments(db, { ticketId: ticket.id });
  recordActivity(db, {
    ticketId: ticket.id,
    actorId: actor.id,
    action: 'completed',
    fromState: 'in_progress',
    toState: 'done',
    metadata: { result_length: result.length },
  });

  return decorateTicket(requireTicket(db, ticket.id));
}

export function blockTicket(db, { ticketId, actor, reason: reasonText } = {}) {
  const ticket = requireTicket(db, ticketId);
  assertNotTerminal(ticket);
  if (ticket.state !== 'in_progress') {
    throw stateError(db, ticket, actor, `cannot block a ticket in state "${ticket.state}"`);
  }
  assertAssignee(ticket, actor);

  const reason = cleanText(reasonText, 'reason', { max: LIMITS.reason, required: true });
  const timestamp = nowIso();
  // A blocked ticket is still held by the agent, so its lease is renewed here as
  // well: otherwise a blocked ticket would be reaped while the agent waits.
  const lease = leaseExpiryIso();

  const result = db.prepare(
    `UPDATE tickets
        SET state = 'blocked', block_reason = ?, lease_expires_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND state = 'in_progress'`,
  ).run(reason, lease, timestamp, ticket.id);
  assertSingleRow(result, 'block the ticket');

  recordActivity(db, {
    ticketId: ticket.id,
    actorId: actor.id,
    action: 'blocked',
    fromState: 'in_progress',
    toState: 'blocked',
    metadata: { reason },
  });

  return decorateTicket(requireTicket(db, ticket.id));
}

export function cancelTicket(db, { ticketId, actor } = {}) {
  const ticket = requireTicket(db, ticketId);
  assertNotTerminal(ticket);
  if (!['open', 'claimed', 'blocked'].includes(ticket.state)) {
    throw new ApiError(
      409,
      ERROR_CODES.INVALID_TRANSITION,
      `cannot cancel a ticket in state "${ticket.state}"; complete it first`,
    );
  }
  if (actor.id !== ticket.created_by && actor.id !== ticket.assignee_id) {
    throw new ApiError(403, ERROR_CODES.NOT_ASSIGNEE, 'only the creator or the assigned agent may cancel this ticket');
  }

  const timestamp = nowIso();
  const result = db.prepare(
    `UPDATE tickets
        SET state = 'cancelled', lease_expires_at = NULL, closed_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND state = ?`,
  ).run(timestamp, timestamp, ticket.id, ticket.state);
  assertSingleRow(result, 'cancel the ticket');

  releaseAssignments(db, { ticketId: ticket.id });
  recordActivity(db, {
    ticketId: ticket.id,
    actorId: actor.id,
    action: 'cancelled',
    fromState: ticket.state,
    toState: 'cancelled',
    metadata: { previous_assignee_id: ticket.assignee_id },
  });

  return decorateTicket(requireTicket(db, ticket.id));
}

function findCancellingAgent(db, ticketId) {
  const row = db
    .prepare("SELECT actor_id FROM activity WHERE ticket_id = ? AND action = 'cancelled' ORDER BY rowid DESC LIMIT 1")
    .get(ticketId);
  return row?.actor_id ?? null;
}

function findCompletingAgent(db, ticketId) {
  const row = db
    .prepare("SELECT actor_id FROM activity WHERE ticket_id = ? AND action = 'completed' ORDER BY rowid DESC LIMIT 1")
    .get(ticketId);
  return row?.actor_id ?? null;
}

export function reopenTicket(db, { ticketId, actor } = {}) {
  const ticket = requireTicket(db, ticketId);
  if (!isTerminal(ticket)) {
    throw new ApiError(409, ERROR_CODES.INVALID_TRANSITION, `ticket is ${ticket.state}; only a finished ticket can be reopened`);
  }

  // Whoever closed the ticket may undo that closure: the creator always, plus the agent
  // that completed a `done` ticket or cancelled a `cancelled` one. Uninvolved agents are
  // still rejected, so a ticket cannot be yanked around by a bystander.
  const closingAgent =
    ticket.state === 'cancelled' ? findCancellingAgent(db, ticket.id) : findCompletingAgent(db, ticket.id);
  const allowed = actor.id === ticket.created_by || (closingAgent !== null && actor.id === closingAgent);
  if (!allowed) {
    throw new ApiError(
      403,
      ERROR_CODES.NOT_ASSIGNEE,
      'only the creator, or the agent that completed or cancelled this ticket, may reopen it',
    );
  }

  const timestamp = nowIso();
  const result = db.prepare(
    `UPDATE tickets
        SET state = 'open', assignee_id = NULL, lease_expires_at = NULL, block_reason = NULL, closed_at = NULL,
            version = version + 1, updated_at = ?
      WHERE id = ? AND state = ?`,
  ).run(timestamp, ticket.id, ticket.state);
  assertSingleRow(result, 'reopen the ticket');

  recordActivity(db, {
    ticketId: ticket.id,
    actorId: actor.id,
    action: 'reopened',
    fromState: ticket.state,
    toState: 'open',
    metadata: {},
  });

  return decorateTicket(requireTicket(db, ticket.id));
}

/* ----------------------------------------------------------------- comments */

export function addComment(db, { ticketId, actor, body } = {}) {
  requireTicket(db, ticketId);
  const text = cleanText(body, 'body', { max: LIMITS.comment, required: true });

  const commentId = newId();
  const timestamp = nowIso();

  db.prepare('INSERT INTO comments (id, ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(
    commentId,
    ticketId,
    actor.id,
    text,
    timestamp,
  );
  db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(timestamp, ticketId);

  return db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
}
