/**
 * Bearer-token authentication plus log redaction.
 *
 * Tokens are never logged, never echoed, and never placed in a URL. The only place
 * a raw token appears is the response body of POST /api/agents, exactly once.
 */
import { ApiError, ERROR_CODES } from './responses.js';
import { authenticate, touchAgent } from '../domain/agents.js';

export const TOUCH_INTERVAL_MS = 60_000;

export function authenticateRequest(db, req) {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header.trim()) : null;
  if (!match) {
    throw new ApiError(401, ERROR_CODES.UNAUTHENTICATED, 'missing bearer token: send "Authorization: Bearer <agent token>"');
  }

  const agent = authenticate(db, match[1]);
  if (!agent) {
    throw new ApiError(401, ERROR_CODES.UNAUTHENTICATED, 'invalid or disabled token');
  }

  const seen = agent.last_seen_at ? Date.parse(agent.last_seen_at) : Number.NaN;
  if (!Number.isFinite(seen) || Date.now() - seen > TOUCH_INTERVAL_MS) {
    touchAgent(db, agent.id);
  }

  return agent;
}

/** Copy of headers safe to log: Authorization is replaced, never truncated. */
export function redactHeaders(headers = {}) {
  const redacted = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = name.toLowerCase() === 'authorization' ? '[redacted]' : value;
  }
  return redacted;
}

/** One request log line: method, path, status, duration. No headers, no bodies. */
export function logRequest(logger, { method, path, status, durationMs, requestId }) {
  const line = `${method} ${path} ${status} ${durationMs}ms rid=${requestId}`;
  if (status >= 500) logger.error?.(line);
  else logger.log?.(line);
}
