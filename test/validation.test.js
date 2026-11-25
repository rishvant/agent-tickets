/**
 * Input validation, pagination caps, optimistic concurrency and 404 behaviour.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createTicket, errorCode, registerAgent, startServer, uniqueName } from './helpers.js';

test('bad filters and limits are 400 VALIDATION_ERROR', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);

  const badState = await api(srv.base, 'GET', '/api/tickets?state=bogus', { token: agent.token });
  assert.equal(badState.status, 400);
  assert.equal(errorCode(badState), 'VALIDATION_ERROR');

  const badPriority = await api(srv.base, 'GET', '/api/tickets?priority=whenever', { token: agent.token });
  assert.equal(badPriority.status, 400);
  assert.equal(errorCode(badPriority), 'VALIDATION_ERROR');

  const badLimit = await api(srv.base, 'GET', '/api/tickets?limit=abc', { token: agent.token });
  assert.equal(badLimit.status, 400);
  assert.equal(errorCode(badLimit), 'VALIDATION_ERROR');

  const zeroLimit = await api(srv.base, 'GET', '/api/tickets?limit=0', { token: agent.token });
  assert.equal(zeroLimit.status, 400);

  const badCursor = await api(srv.base, 'GET', '/api/tickets?cursor=not-a-cursor', { token: agent.token });
  assert.equal(badCursor.status, 400);
  assert.equal(errorCode(badCursor), 'VALIDATION_ERROR');
});

test('an oversized page size is capped, not rejected', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);
  await createTicket(srv.base, agent.token, { title: 'one' });

  const capped = await api(srv.base, 'GET', '/api/tickets?limit=1000', { token: agent.token });
  assert.equal(capped.status, 200);
  assert.equal(capped.body.limit, 100, 'page size is capped at 100');

  const defaulted = await api(srv.base, 'GET', '/api/tickets', { token: agent.token });
  assert.equal(defaulted.body.limit, 20);
});

test('field limits and required fields', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);

  const tooLong = await api(srv.base, 'POST', '/api/tickets', {
    token: agent.token,
    body: { title: 'x'.repeat(201) },
  });
  assert.equal(tooLong.status, 400);
  assert.equal(errorCode(tooLong), 'VALIDATION_ERROR');

  const missingTitle = await api(srv.base, 'POST', '/api/tickets', { token: agent.token, body: {} });
  assert.equal(missingTitle.status, 400);

  const badPriority = await api(srv.base, 'POST', '/api/tickets', {
    token: agent.token,
    body: { title: 'ok', priority: 'urgent-ish' },
  });
  assert.equal(badPriority.status, 400);

  const tooLongBody = await api(srv.base, 'POST', '/api/tickets', {
    token: agent.token,
    body: { title: 'ok', body: 'y'.repeat(20001) },
  });
  assert.equal(tooLongBody.status, 400);

  const notJson = await api(srv.base, 'POST', '/api/tickets', {
    token: agent.token,
    headers: { 'content-type': 'application/json' },
    body: undefined,
  });
  assert.equal(notJson.status, 400, 'an empty body is missing "title"');

  const duplicateName = await api(srv.base, 'POST', '/api/agents', {
    body: { name: agent.agent.name },
  });
  assert.equal(duplicateName.status, 400);
  assert.equal(errorCode(duplicateName), 'VALIDATION_ERROR');
});

test('PATCH requires the creator, an open ticket and the current version', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const creator = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, creator.token, { title: 'original' });

  const noVersion = await api(srv.base, 'PATCH', `/api/tickets/${ticket.id}`, {
    token: creator.token,
    body: { title: 'renamed' },
  });
  assert.equal(noVersion.status, 400);
  assert.equal(errorCode(noVersion), 'VALIDATION_ERROR');

  const badVersion = await api(srv.base, 'PATCH', `/api/tickets/${ticket.id}`, {
    token: creator.token,
    body: { title: 'renamed', version: 'abc' },
  });
  assert.equal(badVersion.status, 400, 'a non-integer version is a validation error, not a conflict');
  assert.equal(errorCode(badVersion), 'VALIDATION_ERROR');

  const ok = await api(srv.base, 'PATCH', `/api/tickets/${ticket.id}`, {
    token: creator.token,
    body: { title: 'renamed', version: ticket.version },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ticket.title, 'renamed');
  assert.equal(ok.body.ticket.version, ticket.version + 1);

  const stale = await api(srv.base, 'PATCH', `/api/tickets/${ticket.id}`, {
    token: creator.token,
    body: { title: 'again', version: ticket.version },
  });
  assert.equal(stale.status, 409);
  assert.equal(errorCode(stale), 'VERSION_CONFLICT');

  // Editing is only allowed while open.
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: creator.token, body: {} });
  const claimed = await api(srv.base, 'PATCH', `/api/tickets/${ticket.id}`, {
    token: creator.token,
    body: { title: 'nope', version: ticket.version + 1 },
  });
  assert.equal(claimed.status, 409);
  assert.equal(errorCode(claimed), 'INVALID_TRANSITION');
});

test('cursor pagination is stable and disjoint', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);
  const created = [];
  for (let index = 0; index < 3; index += 1) {
    created.push(await createTicket(srv.base, agent.token, { title: uniqueName(`page-${index}`) }));
  }

  const page1 = await api(srv.base, 'GET', '/api/tickets?limit=2', { token: agent.token });
  assert.equal(page1.status, 200);
  assert.equal(page1.body.tickets.length, 2);
  assert.equal(typeof page1.body.next_cursor, 'string');

  const page2 = await api(srv.base, 'GET', `/api/tickets?limit=2&cursor=${page1.body.next_cursor}`, {
    token: agent.token,
  });
  assert.equal(page2.status, 200);
  assert.equal(page2.body.tickets.length, 1);
  assert.equal(page2.body.next_cursor, null);

  const seen = [...page1.body.tickets, ...page2.body.tickets].map((ticket) => ticket.id);
  assert.equal(new Set(seen).size, 3, 'pages must not repeat a ticket');
  assert.deepEqual([...seen].sort(), created.map((ticket) => ticket.id).sort());
});

test('filters: state and assignee=me', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const worker = await registerAgent(srv.base);
  const other = await registerAgent(srv.base);

  const mine = await createTicket(srv.base, worker.token, { title: 'mine', priority: 'high' });
  const theirs = await createTicket(srv.base, other.token, { title: 'theirs' });
  await api(srv.base, 'POST', `/api/tickets/${mine.id}/claim`, { token: worker.token, body: {} });

  const claimed = await api(srv.base, 'GET', '/api/tickets?state=claimed', { token: worker.token });
  assert.deepEqual(claimed.body.tickets.map((ticket) => ticket.id), [mine.id]);

  const openOnly = await api(srv.base, 'GET', '/api/tickets?state=open', { token: worker.token });
  assert.deepEqual(openOnly.body.tickets.map((ticket) => ticket.id), [theirs.id]);

  const assignedToMe = await api(srv.base, 'GET', '/api/tickets?assignee=me', { token: worker.token });
  assert.deepEqual(assignedToMe.body.tickets.map((ticket) => ticket.id), [mine.id]);

  const highPriority = await api(srv.base, 'GET', '/api/tickets?priority=high', { token: worker.token });
  assert.deepEqual(highPriority.body.tickets.map((ticket) => ticket.id), [mine.id]);
});

test('unknown resources and endpoints are 404 NOT_FOUND', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);

  const missingTicket = await api(srv.base, 'GET', '/api/tickets/does-not-exist', { token: agent.token });
  assert.equal(missingTicket.status, 404);
  assert.equal(errorCode(missingTicket), 'NOT_FOUND');

  const missingActivity = await api(srv.base, 'GET', '/api/tickets/nope/activity', { token: agent.token });
  assert.equal(missingActivity.status, 404);

  const missingComment = await api(srv.base, 'POST', '/api/tickets/nope/comments', {
    token: agent.token,
    body: { body: 'hello' },
  });
  assert.equal(missingComment.status, 404);

  const missingAction = await api(srv.base, 'POST', '/api/tickets/x/frobnicate', {
    token: agent.token,
    body: {},
  });
  assert.equal(missingAction.status, 404);

  const unknownEndpoint = await api(srv.base, 'GET', '/api/nothing-here', { token: agent.token });
  assert.equal(unknownEndpoint.status, 404);
  assert.equal(errorCode(unknownEndpoint), 'NOT_FOUND');
});
