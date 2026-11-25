/**
 * Ticket routes. Every mutation runs in one transaction covering the state change,
 * the assignment bookkeeping and the single activity row it produces.
 */
import { json, hashRequest, runIdempotent } from '../http/responses.js';
import * as tickets from '../domain/tickets.js';

const TRANSITIONS = {
  claim: (db, { ticketId, actor }) => tickets.claimTicket(db, { ticketId, actor }),
  assign: (db, { ticketId, actor, body }) =>
    tickets.assignTicket(db, { ticketId, actor, assigneeId: body.assignee_id }),
  start: (db, { ticketId, actor }) => tickets.startTicket(db, { ticketId, actor }),
  complete: (db, { ticketId, actor, body }) => tickets.completeTicket(db, { ticketId, actor, result: body.result }),
  block: (db, { ticketId, actor, body }) => tickets.blockTicket(db, { ticketId, actor, reason: body.reason }),
  cancel: (db, { ticketId, actor }) => tickets.cancelTicket(db, { ticketId, actor }),
  reopen: (db, { ticketId, actor }) => tickets.reopenTicket(db, { ticketId, actor }),
};

export function register(router) {
  router.get('/api/tickets', list);
  router.post('/api/tickets', create);
  router.get('/api/tickets/:id', detail);
  router.patch('/api/tickets/:id', patch);
  for (const action of Object.keys(TRANSITIONS)) {
    router.post(`/api/tickets/:id/${action}`, (ctx) => transition(ctx, action));
  }
}

function sendOutcome(ctx, outcome) {
  ctx.res.setHeader('x-idempotency-replay', outcome.replayed ? 'true' : 'false');
  json(ctx.res, outcome.status, outcome.body);
  return outcome.status;
}

function list(ctx) {
  tickets.sweepExpiredLeasesCommitted(ctx.db);
  const assigneeParam = ctx.query.get('assignee');
  const assigneeId = assigneeParam === 'me' ? ctx.agent.id : assigneeParam ?? undefined;
  const result = tickets.listTickets(ctx.db, {
    state: ctx.query.get('state') ?? undefined,
    priority: ctx.query.get('priority') ?? undefined,
    assigneeId,
    limit: ctx.query.get('limit') ?? undefined,
    cursor: ctx.query.get('cursor') ?? undefined,
  });
  json(ctx.res, 200, result);
  return 200;
}

function create(ctx) {
  const endpoint = 'POST /api/tickets';
  const body = ctx.body ?? {};
  const requestHash = hashRequest(endpoint, body);

  const outcome = ctx.db.transaction(() =>
    runIdempotent(
      ctx.db,
      { agentId: ctx.agent.id, key: ctx.idempotencyKey, endpoint, requestHash },
      () => {
        const ticket = tickets.createTicket(ctx.db, {
          actor: ctx.agent,
          title: body.title,
          body: body.body,
          priority: body.priority,
        });
        return { status: 201, body: { ticket } };
      },
    ),
  );

  return sendOutcome(ctx, outcome);
}

function detail(ctx) {
  tickets.sweepExpiredLeasesCommitted(ctx.db);
  const payload = tickets.getTicketDetail(ctx.db, { ticketId: ctx.params.id });
  json(ctx.res, 200, payload);
  return 200;
}

function patch(ctx) {
  const endpoint = 'PATCH /api/tickets/:id';
  const body = ctx.body ?? {};
  const requestHash = hashRequest(endpoint, { ticketId: ctx.params.id, body });

  tickets.sweepExpiredLeasesCommitted(ctx.db);
  const outcome = ctx.db.transaction(() =>
    runIdempotent(
      ctx.db,
      { agentId: ctx.agent.id, key: ctx.idempotencyKey, endpoint, requestHash },
      () => {
        const ticket = tickets.patchTicket(ctx.db, {
          ticketId: ctx.params.id,
          actor: ctx.agent,
          patch: body,
          version: body.version,
        });
        return { status: 200, body: { ticket } };
      },
    ),
  );

  return sendOutcome(ctx, outcome);
}

function transition(ctx, action) {
  const endpoint = `POST /api/tickets/:id/${action}`;
  const body = ctx.body ?? {};
  const requestHash = hashRequest(endpoint, { ticketId: ctx.params.id, body });

  // Committed first: an expired lease must be released even if this action then
  // fails (e.g. the stale holder's /complete returning 409).
  tickets.sweepExpiredLeasesCommitted(ctx.db);

  const outcome = ctx.db.transaction(() =>
    runIdempotent(
      ctx.db,
      { agentId: ctx.agent.id, key: ctx.idempotencyKey, endpoint, requestHash },
      () => {
        const ticket = TRANSITIONS[action](ctx.db, { ticketId: ctx.params.id, actor: ctx.agent, body });
        return { status: 200, body: { ticket } };
      },
    ),
  );

  return sendOutcome(ctx, outcome);
}
