/**
 * Authentication (401) and authorisation (403) negatives, plus the two auth
 * guarantees that are easy to regress: /api/health stays public, and a disabled
 * agent is rejected even though its token still hashes to a stored row.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createTicket, errorCode, registerAgent, startServer, uniqueName } from './helpers.js';

test('missing, malformed, garbage and disabled tokens are all 401', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base, { name: uniqueName('auth') });

  const missing = await api(srv.base, 'GET', '/api/me');
  assert.equal(missing.status, 401);
  assert.equal(errorCode(missing), 'UNAUTHENTICATED');

  const wrongScheme = await api(srv.base, 'GET', '/api/me', { headers: { authorization: agent.token } });
  assert.equal(wrongScheme.status, 401);
  assert.equal(errorCode(wrongScheme), 'UNAUTHENTICATED');

  const garbage = await api(srv.base, 'GET', '/api/me', { token: 'at_totally-not-a-token' });
  assert.equal(garbage.status, 401);
  assert.equal(errorCode(garbage), 'UNAUTHENTICATED');

  const emptyBearer = await api(srv.base, 'GET', '/api/me', { headers: { authorization: 'Bearer ' } });
  assert.equal(emptyBearer.status, 401);
  assert.equal(errorCode(emptyBearer), 'UNAUTHENTICATED');

  // /api/me works before the agent is disabled.
  const before = await api(srv.base, 'GET', '/api/me', { token: agent.token });
  assert.equal(before.status, 200);
  assert.equal(before.body.agent.id, agent.agent.id);
  assert.equal(before.body.agent.token_hash, undefined, 'the token digest must never be returned');

  srv.db.prepare("UPDATE agents SET status = 'disabled' WHERE id = ?").run(agent.agent.id);

  const disabled = await api(srv.base, 'GET', '/api/me', { token: agent.token });
  assert.equal(disabled.status, 401);
  assert.equal(errorCode(disabled), 'UNAUTHENTICATED');

  // Health is public and never requires a token.
  const health = await api(srv.base, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
});

test('authorisation negatives: non-holders cannot mutate a ticket', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const creator = await registerAgent(srv.base, { name: uniqueName('authz-creator') });
  const holder = await registerAgent(srv.base, { name: uniqueName('authz-holder') });
  const third = await registerAgent(srv.base, { name: uniqueName('authz-third') });

  const ticket = await createTicket(srv.base, creator.token, { title: 'guarded' });
  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: holder.token, body: {} })).status, 200);

  const startByThird = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: third.token, body: {} });
  assert.equal(startByThird.status, 403);
  assert.equal(errorCode(startByThird), 'NOT_ASSIGNEE');

  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: holder.token, body: {} })).status, 200);

  const completeByThird = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
    token: third.token,
    body: { result: 'not mine' },
  });
  assert.equal(completeByThird.status, 403);
  assert.equal(errorCode(completeByThird), 'NOT_ASSIGNEE');

  const blockByThird = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/block`, {
    token: third.token,
    body: { reason: 'not mine' },
  });
  assert.equal(blockByThird.status, 403);
  assert.equal(errorCode(blockByThird), 'NOT_ASSIGNEE');

  // in_progress cannot be cancelled by anyone, so the state check wins over the actor check.
  const cancelWhileInProgress = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/cancel`, {
    token: creator.token,
    body: {},
  });
  assert.equal(cancelWhileInProgress.status, 409);
  assert.equal(errorCode(cancelWhileInProgress), 'INVALID_TRANSITION');

  // Editing is creator-only and open-only, so a non-creator gets FORBIDDEN on a fresh open ticket.
  const openTicket = await createTicket(srv.base, creator.token, { title: 'editable' });
  const patchByThird = await api(srv.base, 'PATCH', `/api/tickets/${openTicket.id}`, {
    token: third.token,
    body: { title: 'hijacked', version: openTicket.version },
  });
  assert.equal(patchByThird.status, 403);
  assert.equal(errorCode(patchByThird), 'FORBIDDEN');

  // A third agent cannot reopen a ticket it did not close.
  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
    token: holder.token,
    body: { result: 'done' },
  })).status, 200);
  const reopenByThird = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/reopen`, { token: third.token, body: {} });
  assert.equal(reopenByThird.status, 403);
  assert.equal(errorCode(reopenByThird), 'NOT_ASSIGNEE');
});
