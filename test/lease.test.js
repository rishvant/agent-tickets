/**
 * Lease expiry, deterministically.
 *
 * Expiry is no longer resolved by reads (a GET that took BEGIN IMMEDIATE would
 * serialise reads and risk SQLITE_BUSY), so the contract under test is:
 *
 *   - a GET reports an expired lease as expired (`lease_expired: true`) without
 *     changing the ticket;
 *   - the mutation paths and a bounded background sweeper actually reap it;
 *   - `blocked` tickets are exempt: waiting on input is not time-bounded;
 *   - a stale holder gets 409 LEASE_EXPIRED, distinct from INVALID_TRANSITION.
 *
 * The clock is moved by writing lease_expires_at directly into the real database;
 * there are no fake timers and no sleeps of minutes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createTicket, errorCode, registerAgent, startServer } from './helpers.js';

const MINUTE = 60 * 1000;

function expireLeaseNow(db, ticketId) {
  const past = new Date(Date.now() - MINUTE).toISOString();
  db.prepare('UPDATE tickets SET lease_expires_at = ? WHERE id = ?').run(past, ticketId);
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

test('a read reports an expired lease as expired without reaping it', async (t) => {
  const srv = await startServer({ sweepIntervalMs: 0 });
  t.after(() => srv.close());

  const holder = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, holder.token, { title: 'expired but unread' });

  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: holder.token, body: {} })).status, 200);
  expireLeaseNow(srv.db, ticket.id);

  const read = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: holder.token });
  assert.equal(read.status, 200);
  assert.equal(read.body.ticket.state, 'claimed', 'a GET must not rewrite the ticket');
  assert.equal(read.body.ticket.lease_expired, true, 'but it must report the lease as expired');
  assert.equal(read.body.activity.filter((row) => row.action === 'lease_expired').length, 0);

  // The stale holder's next action runs the sweep and answers LEASE_EXPIRED, not a
  // generic INVALID_TRANSITION.
  const stale = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: holder.token, body: {} });
  assert.equal(stale.status, 409);
  assert.equal(errorCode(stale), 'LEASE_EXPIRED');

  // Now the reaping is visible: back in the queue, one audit row, no audit noise.
  const after = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: holder.token });
  assert.equal(after.body.ticket.state, 'open');
  assert.equal(after.body.ticket.assignee_id, null);
  assert.equal(after.body.ticket.lease_expired, false);

  const expired = after.body.activity.filter((row) => row.action === 'lease_expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].from_state, 'claimed');
  assert.equal(expired[0].to_state, 'open');
  assert.equal(expired[0].actor_id, null);

  // And somebody else can take it.
  const other = await registerAgent(srv.base);
  const reclaimed = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: other.token, body: {} });
  assert.equal(reclaimed.status, 200);
  assert.equal(reclaimed.body.ticket.assignee_id, other.agent.id);
});

test('the mutation path expires the lease before acting', async (t) => {
  const srv = await startServer({ sweepIntervalMs: 0 });
  t.after(() => srv.close());

  const holder = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, holder.token, { title: 'expire on write' });

  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: holder.token, body: {} })).status, 200);
  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: holder.token, body: {} })).status, 200);

  expireLeaseNow(srv.db, ticket.id);

  // No intervening GET: the mutation path must sweep first.
  const complete = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
    token: holder.token,
    body: { result: 'too late' },
  });
  assert.equal(complete.status, 409);
  assert.equal(errorCode(complete), 'LEASE_EXPIRED');

  const rows = srv.db
    .prepare("SELECT from_state, to_state FROM activity WHERE ticket_id = ? AND action = 'lease_expired'")
    .all(ticket.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from_state, 'in_progress');
});

test('a blocked ticket is exempt from expiry: waiting on input is not time-bounded', async (t) => {
  const srv = await startServer({ sweepIntervalMs: 0 });
  t.after(() => srv.close());

  const holder = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, holder.token, { title: 'blocked forever' });

  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: holder.token, body: {} });
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: holder.token, body: {} });
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/block`, {
    token: holder.token,
    body: { reason: 'needs a human decision' },
  });

  expireLeaseNow(srv.db, ticket.id);

  // A mutation runs the sweep; the blocked ticket must survive it with its holder.
  const heartbeat = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/heartbeat`, {
    token: holder.token,
    body: {},
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.ticket.state, 'blocked');

  const read = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: holder.token });
  assert.equal(read.body.ticket.state, 'blocked');
  assert.equal(read.body.ticket.assignee_id, holder.agent.id, 'the holder keeps a blocked ticket');
  assert.equal(read.body.ticket.lease_expired, false);
  assert.equal(read.body.activity.filter((row) => row.action === 'lease_expired').length, 0);

  // The holder can still resume and finish.
  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: holder.token, body: {} })).status, 200);
  const done = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
    token: holder.token,
    body: { result: 'unblocked and finished' },
  });
  assert.equal(done.status, 200);
});

test('the background sweeper reaps an expired lease and stops with the server', async (t) => {
  const srv = await startServer({ sweepIntervalMs: 25 });
  t.after(() => srv.close());

  const holder = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, holder.token, { title: 'swept in the background' });

  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: holder.token, body: {} });
  expireLeaseNow(srv.db, ticket.id);

  const reaped = await waitFor(async () => {
    const read = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: holder.token });
    return read.body.ticket.state === 'open';
  });
  assert.ok(reaped, 'the sweeper should have returned the ticket to open');

  const read = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: holder.token });
  assert.equal(read.body.ticket.assignee_id, null);
  assert.equal(read.body.activity.filter((row) => row.action === 'lease_expired').length, 1);
});

test('claimed, started and blocked tickets always carry a future lease', async (t) => {
  const srv = await startServer({ sweepIntervalMs: 0 });
  t.after(() => srv.close());

  const worker = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, worker.token, { title: 'lease keeps moving' });

  let leases = 0;
  const checkLease = (response) => {
    const lease = response.body.ticket.lease_expires_at;
    assert.ok(lease, 'a held ticket always has a lease');
    assert.ok(Date.parse(lease) > Date.now(), 'the lease must be in the future');
    leases += 1;
  };

  checkLease(await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} }));
  checkLease(await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} }));
  checkLease(
    await api(srv.base, 'POST', `/api/tickets/${ticket.id}/block`, {
      token: worker.token,
      body: { reason: 'waiting on input' },
    }),
  );
  checkLease(await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} }));
  assert.equal(leases, 4);

  const completed = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
    token: worker.token,
    body: { result: 'finished' },
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.ticket.state, 'done');
  assert.equal(completed.body.ticket.lease_expires_at, null);

  expireLeaseNow(srv.db, ticket.id);
  const stillDone = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: worker.token });
  assert.equal(stillDone.body.ticket.state, 'done');
  assert.equal(stillDone.body.activity.filter((row) => row.action === 'lease_expired').length, 0);
});

test('the default lease is 15 minutes', async (t) => {
  const srv = await startServer({ sweepIntervalMs: 0 });
  t.after(() => srv.close());

  const worker = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, worker.token, { title: 'default lease' });

  const claim = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} });
  const remaining = Date.parse(claim.body.ticket.lease_expires_at) - Date.now();

  assert.ok(remaining > 14 * MINUTE, `lease should be near 15 minutes, was ${Math.round(remaining / 1000)}s`);
  assert.ok(remaining <= 15 * MINUTE, `lease must not exceed 15 minutes, was ${Math.round(remaining / 1000)}s`);
});

test('heartbeat extends the lease and the renewed ticket is not swept', async (t) => {
  const srv = await startServer({ sweepIntervalMs: 0 });
  t.after(() => srv.close());

  const worker = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, worker.token, { title: 'heartbeat' });

  const claim = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} });
  assert.equal(claim.status, 200);

  // Simulate a lease that is nearly over without waiting: shorten it in the real database.
  const soon = new Date(Date.now() + 5 * MINUTE).toISOString();
  srv.db.prepare('UPDATE tickets SET lease_expires_at = ? WHERE id = ?').run(soon, ticket.id);

  const heartbeat = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/heartbeat`, {
    token: worker.token,
    body: {},
  });
  assert.equal(heartbeat.status, 200);

  const renewed = heartbeat.body.ticket.lease_expires_at;
  assert.ok(Date.parse(renewed) > Date.parse(soon), 'renewal must move the expiry forward');
  assert.ok(Date.parse(renewed) - Date.now() > 14 * MINUTE, 'renewal grants a full lease window');
  assert.equal(heartbeat.body.ticket.state, 'claimed', 'renewal does not change state');
  assert.equal(heartbeat.body.ticket.version, claim.body.ticket.version + 1);

  // A second renewal runs another sweep first: the ticket must still be held.
  const second = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/heartbeat`, {
    token: worker.token,
    body: {},
  });
  assert.equal(second.status, 200);

  const detail = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: worker.token });
  assert.equal(detail.body.ticket.state, 'claimed');
  assert.equal(detail.body.activity.filter((row) => row.action === 'lease_expired').length, 0);

  const renewals = detail.body.activity.filter((row) => row.action === 'lease_renewed');
  assert.equal(renewals.length, 2);
  assert.equal(renewals[0].from_state, 'claimed');
  assert.equal(renewals[0].to_state, 'claimed');
  assert.equal(renewals[0].actor_id, worker.agent.id);

  // The holder can still finish the work afterwards.
  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} })).status, 200);
  const completed = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
    token: worker.token,
    body: { result: 'finished after renewing' },
  });
  assert.equal(completed.status, 200);
});

test('a stale holder cannot renew: the ticket is already back in the queue', async (t) => {
  const srv = await startServer({ sweepIntervalMs: 0 });
  t.after(() => srv.close());

  const worker = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, worker.token, { title: 'stale heartbeat' });

  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} });
  expireLeaseNow(srv.db, ticket.id);

  const stale = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/heartbeat`, {
    token: worker.token,
    body: {},
  });
  assert.equal(stale.status, 409);
  assert.equal(errorCode(stale), 'LEASE_EXPIRED');

  const detail = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: worker.token });
  assert.equal(detail.body.ticket.state, 'open');
  assert.equal(detail.body.activity.filter((row) => row.action === 'lease_renewed').length, 0);
  assert.equal(detail.body.activity.filter((row) => row.action === 'lease_expired').length, 1);
});

test('a non-holder cannot renew, including a former holder after reassignment', async (t) => {
  const srv = await startServer({ sweepIntervalMs: 0 });
  t.after(() => srv.close());

  const holder = await registerAgent(srv.base);
  const other = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, holder.token, { title: 'not yours' });

  const claim = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: holder.token, body: {} });
  assert.equal(claim.status, 200);
  const leaseBefore = claim.body.ticket.lease_expires_at;

  const foreign = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/heartbeat`, { token: other.token, body: {} });
  assert.equal(foreign.status, 403);
  assert.equal(errorCode(foreign), 'NOT_ASSIGNEE');

  const detail = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: holder.token });
  assert.equal(detail.body.ticket.lease_expires_at, leaseBefore, 'a rejected renewal must not touch the lease');

  expireLeaseNow(srv.db, ticket.id);
  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: other.token, body: {} })).status, 200);

  const formerHolder = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/heartbeat`, {
    token: holder.token,
    body: {},
  });
  assert.equal(formerHolder.status, 403);
  assert.equal(errorCode(formerHolder), 'NOT_ASSIGNEE');
});

test('a finished ticket cannot be renewed', async (t) => {
  const srv = await startServer({ sweepIntervalMs: 0 });
  t.after(() => srv.close());

  const worker = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, worker.token, { title: 'already done' });

  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} });
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} });
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
    token: worker.token,
    body: { result: 'done' },
  });

  const heartbeat = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/heartbeat`, {
    token: worker.token,
    body: {},
  });
  assert.equal(heartbeat.status, 409);
  assert.equal(errorCode(heartbeat), 'TICKET_CLOSED');
});
