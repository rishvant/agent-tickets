/**
 * Lease expiry, deterministically. Instead of waiting 15 minutes or faking timers,
 * the tests write lease_expires_at directly into the real database and then exercise
 * the API: expiry is resolved lazily on read and before every mutation, which is
 * exactly the production behaviour.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createTicket, errorCode, registerAgent, startServer } from './helpers.js';

const MINUTE = 60 * 1000;

function expireLeaseNow(db, ticketId) {
  const past = new Date(Date.now() - MINUTE).toISOString();
  db.prepare('UPDATE tickets SET lease_expires_at = ? WHERE id = ?').run(past, ticketId);
}

test('expired lease returns the ticket to open with exactly one lease_expired row', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const holder = await registerAgent(srv.base);
  const other = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, holder.token, { title: 'lease me' });

  const claim = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: holder.token, body: {} });
  assert.equal(claim.status, 200);
  assert.ok(claim.body.ticket.lease_expires_at, 'claiming sets a lease');

  expireLeaseNow(srv.db, ticket.id);

  const detail = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: other.token });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.ticket.state, 'open');
  assert.equal(detail.body.ticket.assignee_id, null);
  assert.equal(detail.body.ticket.lease_expires_at, null);

  const expired = detail.body.activity.filter((row) => row.action === 'lease_expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].from_state, 'claimed');
  assert.equal(expired[0].to_state, 'open');
  assert.equal(expired[0].actor_id, null, 'the system, not an agent, expired the lease');

  // Reading again must not write a second row: expiry is idempotent.
  const again = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: other.token });
  assert.equal(again.body.activity.filter((row) => row.action === 'lease_expired').length, 1);

  // The stale holder can no longer act on it.
  const stale = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: holder.token, body: {} });
  assert.equal(stale.status, 409);
  assert.equal(errorCode(stale), 'INVALID_TRANSITION');

  // And the ticket is genuinely claimable again by someone else.
  const reclaimed = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: other.token, body: {} });
  assert.equal(reclaimed.status, 200);
  assert.equal(reclaimed.body.ticket.assignee_id, other.agent.id);
});

test('expiry is also resolved on the mutation path, without a prior read', async (t) => {
  const srv = await startServer();
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
  assert.equal(errorCode(complete), 'INVALID_TRANSITION');

  const rows = srv.db
    .prepare("SELECT from_state, to_state FROM activity WHERE ticket_id = ? AND action = 'lease_expired'")
    .all(ticket.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from_state, 'in_progress');
});

test('claimed, started and blocked tickets always carry a future lease', async (t) => {
  const srv = await startServer();
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
  // A blocked ticket stays held, so /block renews the lease (documented deviation:
  // decision 7 lists only /start and /complete as extending it).
  checkLease(
    await api(srv.base, 'POST', `/api/tickets/${ticket.id}/block`, {
      token: worker.token,
      body: { reason: 'waiting on input' },
    }),
  );
  checkLease(await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} }));
  assert.equal(leases, 4);

  // Completion is the exception: it ends the hold and clears the lease.
  const completed = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
    token: worker.token,
    body: { result: 'finished' },
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.ticket.state, 'done');
  assert.equal(completed.body.ticket.lease_expires_at, null);

  // A finished ticket never expires back into the queue, even with a stale lease.
  expireLeaseNow(srv.db, ticket.id);
  const stillDone = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: worker.token });
  assert.equal(stillDone.body.ticket.state, 'done');
  assert.equal(stillDone.body.activity.filter((row) => row.action === 'lease_expired').length, 0);
});

test('the default lease is 15 minutes', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const worker = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, worker.token, { title: 'default lease' });

  const claim = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} });
  const remaining = Date.parse(claim.body.ticket.lease_expires_at) - Date.now();

  assert.ok(remaining > 14 * MINUTE, `lease should be near 15 minutes, was ${Math.round(remaining / 1000)}s`);
  assert.ok(remaining <= 15 * MINUTE, `lease must not exceed 15 minutes, was ${Math.round(remaining / 1000)}s`);
});

test('heartbeat extends the lease and the renewed ticket is not swept', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const worker = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, worker.token, { title: 'heartbeat' });

  const claim = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} });
  assert.equal(claim.status, 200);

  // Simulate a lease that is nearly over, without waiting five minutes: shorten it in
  // the real database. Renewal must move the expiry forward from there.
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

  // A sweep-triggering read must leave it alone: nothing expired, nothing reaped.
  const detail = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: worker.token });
  assert.equal(detail.body.ticket.state, 'claimed');
  assert.equal(detail.body.activity.filter((row) => row.action === 'lease_expired').length, 0);

  // ...and the renewal is in the history like any other action.
  const renewals = detail.body.activity.filter((row) => row.action === 'lease_renewed');
  assert.equal(renewals.length, 1);
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

test('a blocked holder can renew, so a ticket waiting on input is not reaped', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const worker = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, worker.token, { title: 'blocked heartbeat' });

  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} });
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} });
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/block`, {
    token: worker.token,
    body: { reason: 'waiting on input' },
  });

  const heartbeat = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/heartbeat`, {
    token: worker.token,
    body: {},
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.ticket.state, 'blocked');
  assert.ok(Date.parse(heartbeat.body.ticket.lease_expires_at) > Date.now());
});

test('a stale holder cannot renew: the ticket is already back in open', async (t) => {
  const srv = await startServer();
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
  assert.equal(errorCode(stale), 'INVALID_TRANSITION');

  const detail = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: worker.token });
  assert.equal(detail.body.ticket.state, 'open');
  assert.equal(detail.body.activity.filter((row) => row.action === 'lease_renewed').length, 0);
  assert.equal(detail.body.activity.filter((row) => row.action === 'lease_expired').length, 1);
});

test('a non-holder cannot renew, including a former holder after reassignment', async (t) => {
  const srv = await startServer();
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

  // A rejected renewal must not touch the lease.
  const detail = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: holder.token });
  assert.equal(detail.body.ticket.lease_expires_at, leaseBefore);

  // Former holder: lease lapses, the ticket is reclaimed by someone else, and the old
  // holder's heartbeat is now a plain authorisation failure rather than a renewal.
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
  const srv = await startServer();
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
