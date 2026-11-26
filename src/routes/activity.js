/**
 * Read-only audit trail for a ticket. Append-only is enforced in the database by
 * triggers, so there is no write route for this resource by design.
 */
import { ApiError, ERROR_CODES, json } from '../http/responses.js';
import * as tickets from '../domain/tickets.js';

export function register(router) {
  router.get('/api/tickets/:id/activity', activity);
}

function activity(ctx) {
  if (!tickets.getTicketRow(ctx.db, ctx.params.id)) {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'ticket not found');
  }
  const rows = tickets.listActivity(ctx.db, { ticketId: ctx.params.id });
  json(ctx.res, 200, { activity: rows });
  return 200;
}
