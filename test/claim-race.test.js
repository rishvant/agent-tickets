/**
 * The race test: 100 distinct agents claim the same open ticket simultaneously.
 *
 * Why 100 DISTINCT agents and not 2:
 *   decision 6 limits an agent to one active ticket, so if the losers were the same
 *   agent reused 99 times they could legitimately fail with AGENT_BUSY, and the
 *   assertions would stop proving anything about the claim path. With 100 agents
 *   that each hold nothing, AGENT_BUSY can never be the reason for a loss. Every
 *   loser must therefore be a well-formed 409 TICKET_ALREADY_CLAIMED, which is
 *   exactly the behaviour we want to pin down.
 *
 * Concurrency note: the server is single-threaded and the SQLite driver is
 * synchronous, so requests do not literally run in parallel. What is being tested
 * is that the guarantee survives interleaving at every await boundary - the claim
 * itself is one conditional UPDATE, so the first transaction to run wins and the
 * rest observe state='claimed'.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createTicket, errorCode, registerAgent, startServer } from './helpers.js';

const CLAIMANTS = 100;

test('claim is atomic: 100 concurrent claimants, exactly one wins', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const claimants = await Promise.all(
    Array.from({ length: CLAIMANTS }, (_, index) => registerAgent(srv.base, { name: `race-${index}` })),
  );

  const ticket = await createTicket(srv.base, claimants[0].token, { title: 'one winner' });

  const responses = await Promise.all(
    claimants.map((claimant) =>
      api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: claimant.token, body: {} }),
    ),
  );

  const wins = responses.filter((response) => response.status === 200);
  const losses = responses.filter((response) => response.status !== 200);

  assert.equal(wins.length, 1, `expected exactly 1 successful claim, got ${wins.length}`);
  assert.equal(losses.length, CLAIMANTS - 1);

  for (const loss of losses) {
    assert.equal(loss.status, 409, 'every loser must get a 409');
    assert.equal(errorCode(loss), 'TICKET_ALREADY_CLAIMED', 'and specifically TICKET_ALREADY_CLAIMED');
    assert.equal(typeof loss.body?.error?.message, 'string');
  }

  const claimedActivity = srv.db
    .prepare("SELECT id FROM activity WHERE ticket_id = ? AND action = 'claimed'")
    .all(ticket.id);
  assert.equal(claimedActivity.length, 1, 'exactly one claimed activity row');

  const winnerIndex = responses.findIndex((response) => response.status === 200);
  const stored = srv.db.prepare('SELECT state, assignee_id, lease_expires_at FROM tickets WHERE id = ?').get(ticket.id);
  assert.equal(stored.state, 'claimed');
  assert.equal(stored.assignee_id, claimants[winnerIndex].agent.id);
  assert.ok(stored.lease_expires_at, 'the winner receives a lease');

  // No other ticket was created or mutated by the losing attempts.
  const totalTickets = srv.db.prepare('SELECT COUNT(*) AS total FROM tickets').get();
  assert.equal(Number(totalTickets.total), 1);
});
