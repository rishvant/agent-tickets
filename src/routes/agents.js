/**
 * Agent registry routes.
 *
 * POST /api/agents is intentionally public in P0: a fresh installation must be able
 * to mint its first token. Anyone who can reach the port can register an agent, so
 * bind the server to localhost. Closing this (admin-token-only registration) is a
 * P1 item, called out in the README.
 */
import { json } from '../http/responses.js';
import { countActiveTickets, listAgents, registerAgent } from '../domain/agents.js';

export function register(router) {
  router.post('/api/agents', createAgent, { public: true });
  router.get('/api/agents', list);
  router.get('/api/me', me);
}

function createAgent(ctx) {
  // Registration is not idempotency-keyed: no agent identity exists yet to scope a
  // key to, and a duplicate registration is an obviously different request.
  const outcome = ctx.db.transaction(() => {
    const { agent, token } = registerAgent(ctx.db, ctx.body ?? {});
    return { status: 201, body: { agent, token } };
  });
  json(ctx.res, outcome.status, outcome.body);
  return outcome.status;
}

function list(ctx) {
  json(ctx.res, 200, { agents: listAgents(ctx.db) });
  return 200;
}

function me(ctx) {
  json(ctx.res, 200, { agent: ctx.agent, active_tickets: countActiveTickets(ctx.db, ctx.agent.id) });
  return 200;
}
