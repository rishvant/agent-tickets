/**
 * Audit-trail guarantees: the table is append-only in the database itself, and each
 * transition contributes exactly one row (no double writes, no silent rewrites).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createTicket, registerAgent, startServer } from './helpers.js';

test('direct UPDATE and DELETE on activity are rejected', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, agent.token, { title: 'audited' });

  const row = srv.db.prepare('SELECT id, action FROM activity WHERE ticket_id = ? ORDER BY rowid ASC LIMIT 1').get(ticket.id);
  assert.ok(row, 'creating a ticket writes an activity row');
  assert.equal(row.action, 'created');

  assert.throws(
    () => srv.db.prepare('UPDATE activity SET action = ? WHERE id = ?').run('tampered', row.id),
    /append-only/,
    'UPDATE must abort',
  );

  assert.throws(
    () => srv.db.prepare('DELETE FROM activity WHERE id = ?').run(row.id),
    /append-only/,
    'DELETE must abort',
  );

  // The row is untouched.
  const after = srv.db.prepare('SELECT action FROM activity WHERE id = ?').get(row.id);
  assert.equal(after.action, 'created');
});

test('bulk DELETE on activity is also rejected', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);
  await createTicket(srv.base, agent.token, { title: 'one' });
  await createTicket(srv.base, agent.token, { title: 'two' });

  assert.throws(() => srv.db.prepare('DELETE FROM activity').run(), /append-only/);

  const remaining = srv.db.prepare('SELECT COUNT(*) AS total FROM activity').get();
  assert.equal(Number(remaining.total), 2);
});

test('each transition writes exactly one activity row', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const worker = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, worker.token, { title: 'counted' });

  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} });
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} });
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, { token: worker.token, body: { result: 'done' } });

  const actions = srv.db
    .prepare('SELECT action FROM activity WHERE ticket_id = ? ORDER BY rowid ASC')
    .all(ticket.id)
    .map((row) => row.action);

  assert.deepEqual(actions, ['created', 'claimed', 'started', 'completed']);

  // A rejected transition adds nothing.
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} });
  const afterRejection = srv.db.prepare('SELECT COUNT(*) AS total FROM activity WHERE ticket_id = ?').get(ticket.id);
  assert.equal(Number(afterRejection.total), 4);

  // The trail is readable through the API in chronological order.
  const history = await api(srv.base, 'GET', `/api/tickets/${ticket.id}/activity`, { token: worker.token });
  assert.equal(history.status, 200);
  assert.deepEqual(
    history.body.activity.map((entry) => entry.action),
    ['created', 'claimed', 'started', 'completed'],
  );
  assert.equal(history.body.activity[3].from_state, 'in_progress');
  assert.equal(history.body.activity[3].to_state, 'done');
});

test('comments are recorded but do not masquerade as state changes', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const agent = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, agent.token, { title: 'commented' });

  const comment = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/comments`, {
    token: agent.token,
    body: { body: 'working on it' },
  });
  assert.equal(comment.status, 201);
  assert.equal(comment.body.comment.body, 'working on it');

  const detail = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: agent.token });
  assert.equal(detail.body.comments.length, 1);
  assert.equal(detail.body.activity.filter((row) => row.action === 'commented').length, 0);
});
