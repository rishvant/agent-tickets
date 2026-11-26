/**
 * Comments on a ticket. Comments are not state changes, so they deliberately do
 * not write an activity row: the comments table is their record.
 */
import { json, hashRequest, runIdempotent } from '../http/responses.js';
import * as tickets from '../domain/tickets.js';

export function register(router) {
  router.post('/api/tickets/:id/comments', addComment);
}

function addComment(ctx) {
  const endpoint = 'POST /api/tickets/:id/comments';
  const body = ctx.body ?? {};
  const requestHash = hashRequest(endpoint, { ticketId: ctx.params.id, body });

  tickets.sweepExpiredLeasesCommitted(ctx.db);

  const outcome = ctx.db.transaction(() =>
    runIdempotent(
      ctx.db,
      { agentId: ctx.agent.id, key: ctx.idempotencyKey, endpoint, requestHash },
      () => {
        const comment = tickets.addComment(ctx.db, {
          ticketId: ctx.params.id,
          actor: ctx.agent,
          body: body.body,
        });
        return { status: 201, body: { comment } };
      },
    ),
  );

  ctx.res.setHeader('x-idempotency-replay', outcome.replayed ? 'true' : 'false');
  json(ctx.res, outcome.status, outcome.body);
  return outcome.status;
}
