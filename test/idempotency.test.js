/**
 * Idempotency: replays, mismatch detection, retention, and the documented
 * staleness of a replayed response.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createTicket, errorCode, registerAgent, startServer } from './helpers.js';

test('same key + same body replays the stored response and creates one ticket', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);
  const key = 'replay-ticket-1';
  const body = { title: 'idempotent ticket', priority: 'high' };

  const first = await api(srv.base, 'POST', '/api/tickets', {
    token: agent.token,
    body,
    headers: { 'idempotency-key': key },
  });
  assert.equal(first.status, 201);
  assert.equal(first.headers.get('x-idempotency-replay'), 'false');

  const second = await api(srv.base, 'POST', '/api/tickets', {
    token: agent.token,
    body,
    headers: { 'idempotency-key': key },
  });
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('x-idempotency-replay'), 'true');
  assert.deepEqual(second.body, first.body);

  const list = await api(srv.base, 'GET', '/api/tickets', { token: agent.token });
  const created = list.body.tickets.filter((ticket) => ticket.title === 'idempotent ticket');
  assert.equal(created.length, 1, 'the replay must not create a second ticket');
});

test('without an Idempotency-Key, identical POSTs are two separate requests', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);
  const body = { title: 'no key, no replay protection' };

  const first = await api(srv.base, 'POST', '/api/tickets', { token: agent.token, body });
  const second = await api(srv.base, 'POST', '/api/tickets', { token: agent.token, body });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.headers.get('x-idempotency-replay'), 'false');
  assert.equal(second.headers.get('x-idempotency-replay'), 'false');
  assert.notEqual(second.body.ticket.id, first.body.ticket.id, 'no header means no replay');
  assert.notEqual(second.body.ticket.key, first.body.ticket.key);

  const list = await api(srv.base, 'GET', '/api/tickets', { token: agent.token });
  assert.equal(list.body.tickets.filter((ticket) => ticket.title === body.title).length, 2);
});

test('same key + different body is 422 IDEMPOTENCY_MISMATCH', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);
  const key = 'replay-ticket-2';

  const first = await api(srv.base, 'POST', '/api/tickets', {
    token: agent.token,
    body: { title: 'original' },
    headers: { 'idempotency-key': key },
  });
  assert.equal(first.status, 201);

  const mismatch = await api(srv.base, 'POST', '/api/tickets', {
    token: agent.token,
    body: { title: 'different' },
    headers: { 'idempotency-key': key },
  });
  assert.equal(mismatch.status, 422);
  assert.equal(errorCode(mismatch), 'IDEMPOTENCY_MISMATCH');
});

test('keys are scoped per agent', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const first = await registerAgent(srv.base);
  const second = await registerAgent(srv.base);
  const key = 'shared-key';

  const a = await api(srv.base, 'POST', '/api/tickets', {
    token: first.token,
    body: { title: 'agent one ticket' },
    headers: { 'idempotency-key': key },
  });
  assert.equal(a.status, 201);

  const b = await api(srv.base, 'POST', '/api/tickets', {
    token: second.token,
    body: { title: 'agent two ticket' },
    headers: { 'idempotency-key': key },
  });
  assert.equal(b.status, 201, 'the same key from a different agent is a different operation');
  assert.notEqual(b.body.ticket.id, a.body.ticket.id);
});

test('a replay reports the old response even after the lease expired (documented staleness)', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, agent.token, { title: 'stale replay' });
  const key = 'claim-replay-1';

  const claim = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, {
    token: agent.token,
    body: {},
    headers: { 'idempotency-key': key },
  });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.ticket.state, 'claimed');

  // Time passes: the lease lapses. Another agent takes the ticket over, which also
  // runs the expiry sweep on that mutation path.
  const past = new Date(Date.now() - 60_000).toISOString();
  srv.db.prepare('UPDATE tickets SET lease_expires_at = ? WHERE id = ?').run(past, ticket.id);

  const second = await registerAgent(srv.base);
  const reclaimed = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, {
    token: second.token,
    body: {},
  });
  assert.equal(reclaimed.status, 200);
  assert.equal(reclaimed.body.ticket.assignee_id, second.agent.id);

  // Replaying the original claim returns the stored 200 with the OLD payload, verbatim.
  const replay = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, {
    token: agent.token,
    body: {},
    headers: { 'idempotency-key': key },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-idempotency-replay'), 'true');
  assert.equal(replay.body.ticket.state, 'claimed', 'replay is a historical record, not current state');
  assert.equal(replay.body.ticket.version, claim.body.ticket.version);

  // The ticket itself was not re-claimed by the replay: it still belongs to the second agent.
  const after = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: agent.token });
  assert.equal(after.body.ticket.state, 'claimed');
  assert.equal(after.body.ticket.assignee_id, second.agent.id);
});

test('old idempotency records are pruned after 24h', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);
  const key = 'stale-key';

  await api(srv.base, 'POST', '/api/tickets', {
    token: agent.token,
    body: { title: 'pruned' },
    headers: { 'idempotency-key': key },
  });

  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  srv.db.prepare('UPDATE idempotency_keys SET created_at = ? WHERE key = ?').run(stale, key);

  // Any subsequent POST prunes; the key is then free to be reused.
  const reused = await api(srv.base, 'POST', '/api/tickets', {
    token: agent.token,
    body: { title: 'different but allowed after retention' },
    headers: { 'idempotency-key': key },
  });
  assert.equal(reused.status, 201);
  assert.equal(errorCode(reused), null);
});
