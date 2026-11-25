/**
 * Response helpers, the error catalogue, request ids and idempotency.
 *
 * Every error the API emits has a stable machine-readable `code` plus a human
 * message. Raw exceptions never reach the client: anything unexpected becomes a
 * 500 with code INTERNAL_ERROR and the stack is only logged server-side.
 */
import { createHash, randomUUID } from 'node:crypto';

export const ERROR_CODES = Object.freeze({
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  TICKET_CLOSED: 'TICKET_CLOSED',
  TICKET_ALREADY_CLAIMED: 'TICKET_ALREADY_CLAIMED',
  NOT_ASSIGNEE: 'NOT_ASSIGNEE',
  AGENT_BUSY: 'AGENT_BUSY',
  SELF_ASSIGNMENT: 'SELF_ASSIGNMENT',
  TICKET_IN_PROGRESS: 'TICKET_IN_PROGRESS',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  IDEMPOTENCY_MISMATCH: 'IDEMPOTENCY_MISMATCH',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  // Not in the agreed catalogue: the only code for an unexpected 500. Documented
  // in the README so clients can still switch exhaustively.
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

export const MAX_BODY_BYTES = 256 * 1024;
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function newRequestId() {
  return randomUUID();
}

export function json(res, status, body) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body === undefined ? {} : body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(payload));
  res.end(payload);
}

export function errorBody(code, message, requestId, details) {
  const error = { code, message };
  if (requestId) error.request_id = requestId;
  if (details !== undefined) error.details = details;
  return { error };
}

export function sendError(res, error, requestId, logger = console) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // nothing useful to do
    }
    return error instanceof ApiError ? error.status : 500;
  }
  if (error instanceof ApiError) {
    json(res, error.status, errorBody(error.code, error.message, requestId, error.details));
    return error.status;
  }
  logger.error?.(`[error] unhandled exception rid=${requestId}: ${error && error.stack ? error.stack : String(error)}`);
  json(res, 500, errorBody(ERROR_CODES.INTERNAL_ERROR, 'unexpected server error', requestId));
  return 500;
}

/**
 * Reads and parses a JSON object body with a hard size cap.
 * An empty body is treated as {} so that POSTs with no payload stay ergonomic.
 */
export function readJsonBody(req, { limit = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish(reject, new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `request body exceeds ${limit} bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      if (chunks.length === 0) {
        finish(resolve, {});
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish(reject, new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'request body is not valid JSON'));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish(reject, new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'request body must be a JSON object'));
        return;
      }
      finish(resolve, parsed);
    });

    req.on('error', (error) => finish(reject, error));
  });
}

/** Stable JSON for hashing: object keys sorted at every depth. */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function hashRequest(endpoint, payload) {
  return createHash('sha256').update(`${endpoint}\n${canonicalJson(payload)}`, 'utf8').digest('hex');
}

/**
 * Idempotent execution of a mutation. MUST be called inside a db.transaction():
 * the stored response and the mutation it describes commit or roll back together.
 *
 *   same key + same request hash   -> stored response replayed verbatim
 *   same key + different body      -> 422 IDEMPOTENCY_MISMATCH
 *
 * Replays are returned as-is regardless of current state. A replay recorded before
 * a lease expired will still report the original 200; clients should compare the
 * `version` in the payload with the current ticket before acting on it.
 */
export function runIdempotent(db, { agentId, key, endpoint, requestHash }, run) {
  if (!key) return { ...run(), replayed: false };

  const cutoff = new Date(Date.now() - IDEMPOTENCY_RETENTION_MS).toISOString();
  db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff);

  const stored = db
    .prepare('SELECT request_hash, status, response_body FROM idempotency_keys WHERE agent_id = ? AND key = ?')
    .get(agentId, key);

  if (stored) {
    if (stored.request_hash !== requestHash) {
      throw new ApiError(
        422,
        ERROR_CODES.IDEMPOTENCY_MISMATCH,
        'this Idempotency-Key was already used with a different request body',
      );
    }
    return { status: stored.status, body: JSON.parse(stored.response_body), replayed: true };
  }

  const outcome = run();
  db.prepare(
    `INSERT INTO idempotency_keys (agent_id, key, endpoint, request_hash, status, response_body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(agentId, key, endpoint, requestHash, outcome.status, JSON.stringify(outcome.body), new Date().toISOString());

  return { ...outcome, replayed: false };
}
