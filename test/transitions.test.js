/**
 * Table-driven transition matrix: every (state x action x actor) combination.
 *
 * Expected outcomes are derived from the locked decisions, not from the
 * implementation, so this suite is a specification as much as a test:
 *
 *   open        -> creator / third                 (no holder exists yet)
 *   claimed     -> creator / holder / third
 *   in_progress -> creator / holder / third
 *   blocked     -> creator / holder / third
 *   done        -> creator / holder / third        (holder completed it)
 *   cancelled   -> creator / holder / third        (holder cancelled it)
 *
 * Precedence, applied in this order:
 *   1. terminal state + any action except /reopen  -> 409 TICKET_CLOSED
 *   2. terminal state + /reopen                    -> creator or canceller 200, else 403
 *   3. live state, action does not apply           -> 409 INVALID_TRANSITION
 *   4. live state, action applies, wrong actor     -> 403 NOT_ASSIGNEE
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createTicket, errorCode, registerAgent, startServer, uniqueName } from './helpers.js';

const STATES = ['open', 'claimed', 'in_progress', 'blocked', 'done', 'cancelled'];
const ACTIONS = ['claim', 'assign', 'start', 'complete', 'block', 'cancel', 'reopen'];

function rolesFor(state) {
  return state === 'open' ? ['creator', 'third'] : ['creator', 'holder', 'third'];
}

function expected(state, action, role) {
  const terminal = state === 'done' || state === 'cancelled';

  if (terminal) {
    if (action !== 'reopen') return { status: 409, code: 'TICKET_CLOSED' };
    if (role === 'creator') return { status: 200 };
    // Both terminal fixtures are closed by the holder (it completes the `done` one and
    // cancels the `cancelled` one), and whoever closed a ticket may reopen it.
    if (role === 'holder') return { status: 200 };
    return { status: 403, code: 'NOT_ASSIGNEE' };
  }

  switch (action) {
    case 'claim':
      if (state === 'open') return { status: 200 };
      return { status: 409, code: 'TICKET_ALREADY_CLAIMED' };
    case 'assign':
      if (state === 'in_progress') return { status: 409, code: 'TICKET_IN_PROGRESS' };
      return { status: 200 };
    case 'start':
      if (state !== 'claimed' && state !== 'blocked') return { status: 409, code: 'INVALID_TRANSITION' };
      return role === 'holder' ? { status: 200 } : { status: 403, code: 'NOT_ASSIGNEE' };
    case 'complete':
      if (state !== 'in_progress') return { status: 409, code: 'INVALID_TRANSITION' };
      return role === 'holder' ? { status: 200 } : { status: 403, code: 'NOT_ASSIGNEE' };
    case 'block':
      if (state !== 'in_progress') return { status: 409, code: 'INVALID_TRANSITION' };
      return role === 'holder' ? { status: 200 } : { status: 403, code: 'NOT_ASSIGNEE' };
    case 'cancel':
      if (state === 'in_progress') return { status: 409, code: 'INVALID_TRANSITION' };
      if (role === 'creator' || role === 'holder') return { status: 200 };
      return { status: 403, code: 'NOT_ASSIGNEE' };
    case 'reopen':
      return { status: 409, code: 'INVALID_TRANSITION' };
    default:
      throw new Error(`no expectation for action "${action}"`);
  }
}

async function buildTicket(base, state) {
  const creator = await registerAgent(base, { name: uniqueName('creator') });
  const holder = await registerAgent(base, { name: uniqueName('holder') });
  const third = await registerAgent(base, { name: uniqueName('third') });
  const target = await registerAgent(base, { name: uniqueName('target') });

  const ticket = await createTicket(base, creator.token, { title: `${state} fixture ${uniqueName('t')}` });
  const agents = { creator, holder, third, target };

  const step = async (label, response) => {
    assert.equal(response.status, 200, `fixture step "${label}" failed for state ${state}: ${JSON.stringify(response.body)}`);
  };

  if (state === 'open') return { ticket, agents };

  await step('claim', await api(base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: holder.token, body: {} }));

  // A cancelled fixture is cancelled from `claimed`, not from `in_progress`: /cancel
  // is only legal from open|claimed|blocked, and this also makes the holder the
  // canceller, which is what the reopen expectations assume.
  if (state === 'cancelled') {
    await step('cancel', await api(base, 'POST', `/api/tickets/${ticket.id}/cancel`, { token: holder.token, body: {} }));
    return { ticket, agents };
  }

  if (state === 'claimed') return { ticket, agents };

  await step('start', await api(base, 'POST', `/api/tickets/${ticket.id}/start`, { token: holder.token, body: {} }));
  if (state === 'in_progress') return { ticket, agents };

  if (state === 'blocked') {
    await step(
      'block',
      await api(base, 'POST', `/api/tickets/${ticket.id}/block`, { token: holder.token, body: { reason: 'fixture' } }),
    );
    return { ticket, agents };
  }

  if (state === 'done') {
    await step(
      'complete',
      await api(base, 'POST', `/api/tickets/${ticket.id}/complete`, {
        token: holder.token,
        body: { result: 'fixture result' },
      }),
    );
    return { ticket, agents };
  }

  if (state === 'cancelled') {
    await step('cancel', await api(base, 'POST', `/api/tickets/${ticket.id}/cancel`, { token: holder.token, body: {} }));
    return { ticket, agents };
  }

  throw new Error(`cannot build fixture for state "${state}"`);
}

async function perform(base, { action, role, ticket, agents }) {
  const actor = role === 'creator' ? agents.creator : role === 'holder' ? agents.holder : agents.third;

  const body = {};
  if (action === 'assign') body.assignee_id = agents.target.agent.id;
  if (action === 'complete') body.result = 'matrix result';
  if (action === 'block') body.reason = 'matrix reason';

  return api(base, 'POST', `/api/tickets/${ticket.id}/${action}`, { token: actor.token, body });
}

test('transition matrix covers every state x action x actor', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const failures = [];
  let cases = 0;

  for (const state of STATES) {
    for (const action of ACTIONS) {
      for (const role of rolesFor(state)) {
        cases += 1;
        const fixture = await buildTicket(srv.base, state);
        const response = await perform(srv.base, { action, role, ticket: fixture.ticket, agents: fixture.agents });
        const want = expected(state, action, role);
        const label = `${state} + ${action} as ${role}`;

        if (response.status !== want.status) {
          failures.push(
            `${label}: expected HTTP ${want.status}, got ${response.status} (${errorCode(response) ?? 'no code'})`,
          );
          continue;
        }
        if (want.code && errorCode(response) !== want.code) {
          failures.push(`${label}: expected code ${want.code}, got ${errorCode(response) ?? 'none'}`);
        }
      }
    }
  }

  assert.deepEqual(failures, [], `transition matrix mismatches:\n${failures.join('\n')}`);
  assert.equal(cases, 7 * (2 + 3 * 5), 'expected 119 matrix cases');
});

test('locks: one active ticket per agent, no self-assignment, no in-progress reassign', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const worker = await registerAgent(srv.base, { name: uniqueName('busy-worker') });
  const other = await registerAgent(srv.base, { name: uniqueName('busy-other') });
  const idle = await registerAgent(srv.base, { name: uniqueName('busy-idle') });

  const first = await createTicket(srv.base, worker.token, { title: 'first' });
  const second = await createTicket(srv.base, other.token, { title: 'second' });

  const claimed = await api(srv.base, 'POST', `/api/tickets/${first.id}/claim`, { token: worker.token, body: {} });
  assert.equal(claimed.status, 200);

  const busyClaim = await api(srv.base, 'POST', `/api/tickets/${second.id}/claim`, { token: worker.token, body: {} });
  assert.equal(busyClaim.status, 409);
  assert.equal(errorCode(busyClaim), 'AGENT_BUSY');

  const busyAssign = await api(srv.base, 'POST', `/api/tickets/${second.id}/assign`, {
    token: other.token,
    body: { assignee_id: worker.agent.id },
  });
  assert.equal(busyAssign.status, 409);
  assert.equal(errorCode(busyAssign), 'AGENT_BUSY');

  const selfAssign = await api(srv.base, 'POST', `/api/tickets/${second.id}/assign`, {
    token: other.token,
    body: { assignee_id: other.agent.id },
  });
  assert.equal(selfAssign.status, 409);
  assert.equal(errorCode(selfAssign), 'SELF_ASSIGNMENT');

  const started = await api(srv.base, 'POST', `/api/tickets/${first.id}/start`, { token: worker.token, body: {} });
  assert.equal(started.status, 200);

  const reassign = await api(srv.base, 'POST', `/api/tickets/${first.id}/assign`, {
    token: other.token,
    body: { assignee_id: idle.agent.id },
  });
  assert.equal(reassign.status, 409);
  assert.equal(errorCode(reassign), 'TICKET_IN_PROGRESS');

  // Assigning to a disabled or unknown agent is a validation problem, not a conflict.
  srv.db.prepare("UPDATE agents SET status = 'disabled' WHERE id = ?").run(idle.agent.id);
  const disabled = await api(srv.base, 'POST', `/api/tickets/${second.id}/assign`, {
    token: other.token,
    body: { assignee_id: idle.agent.id },
  });
  assert.equal(disabled.status, 400);
  assert.equal(errorCode(disabled), 'VALIDATION_ERROR');

  const unknown = await api(srv.base, 'POST', `/api/tickets/${second.id}/assign`, {
    token: other.token,
    body: { assignee_id: 'no-such-agent' },
  });
  assert.equal(unknown.status, 400);
  assert.equal(errorCode(unknown), 'VALIDATION_ERROR');
});

test('two concurrent completions: exactly one succeeds and writes one audit row', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const worker = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, worker.token, { title: 'one completion only' });

  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} });
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} });

  const responses = await Promise.all([
    api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
      token: worker.token,
      body: { result: 'first caller' },
    }),
    api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
      token: worker.token,
      body: { result: 'second caller' },
    }),
  ]);

  const wins = responses.filter((response) => response.status === 200);
  const losses = responses.filter((response) => response.status !== 200);

  assert.equal(wins.length, 1, 'exactly one completion may win');
  assert.equal(losses.length, 1);
  assert.equal(losses[0].status, 409);
  assert.equal(errorCode(losses[0]), 'TICKET_CLOSED');

  const completedRows = srv.db
    .prepare("SELECT id FROM activity WHERE ticket_id = ? AND action = 'completed'")
    .all(ticket.id);
  assert.equal(completedRows.length, 1, 'the rejected completion must not write an audit row');

  const read = await api(srv.base, 'GET', `/api/tickets/${ticket.id}`, { token: worker.token });
  assert.equal(read.body.ticket.state, 'done');
  assert.equal(read.body.ticket.result, wins[0].body.ticket.result);
});

test('reopen puts a finished ticket back in play and it can be completed again', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const creator = await registerAgent(srv.base);
  const worker = await registerAgent(srv.base);
  const ticket = await createTicket(srv.base, creator.token, { title: 'reopen me' });

  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} });
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} });
  const first = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
    token: worker.token,
    body: { result: 'first pass' },
  });
  assert.equal(first.status, 200);

  const reopened = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/reopen`, { token: creator.token, body: {} });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.ticket.state, 'open');
  assert.equal(reopened.body.ticket.assignee_id, null);
  assert.equal(reopened.body.ticket.closed_at, null);
  assert.equal(reopened.body.ticket.block_reason, null);

  // A finished ticket does not hold the agent busy, so the same worker can take it again.
  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} })).status, 200);
  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} })).status, 200);
  const second = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
    token: worker.token,
    body: { result: 'second pass' },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.ticket.result, 'second pass');

  const actions = srv.db
    .prepare('SELECT action FROM activity WHERE ticket_id = ? ORDER BY rowid ASC')
    .all(ticket.id)
    .map((row) => row.action);
  assert.deepEqual(actions, [
    'created',
    'claimed',
    'started',
    'completed',
    'reopened',
    'claimed',
    'started',
    'completed',
  ]);
});

test('any agent may reassign a held ticket; the old holder loses it', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const creator = await registerAgent(srv.base);
  const holder = await registerAgent(srv.base);
  const triager = await registerAgent(srv.base); // neither creator nor holder
  const next = await registerAgent(srv.base);

  const ticket = await createTicket(srv.base, creator.token, { title: 'triage me' });
  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: holder.token, body: {} })).status, 200);

  // Intentional triage semantics: assignment has no ownership check, so any authenticated
  // agent can move a held ticket to another active agent.
  const reassigned = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/assign`, {
    token: triager.token,
    body: { assignee_id: next.agent.id },
  });
  assert.equal(reassigned.status, 200);
  assert.equal(reassigned.body.ticket.assignee_id, next.agent.id);
  assert.equal(reassigned.body.ticket.state, 'claimed');

  // The old holder is no longer the holder, so it is rejected as NOT_ASSIGNEE.
  const stale = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: holder.token, body: {} });
  assert.equal(stale.status, 403);
  assert.equal(errorCode(stale), 'NOT_ASSIGNEE');

  // Same answer from /heartbeat, which is legal in this state. (/complete would be a 409
  // INVALID_TRANSITION instead: state is checked before the actor, by design.)
  const staleRenew = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/heartbeat`, {
    token: holder.token,
    body: {},
  });
  assert.equal(staleRenew.status, 403);
  assert.equal(errorCode(staleRenew), 'NOT_ASSIGNEE');

  // The new holder can work on it.
  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: next.token, body: {} })).status, 200);
});

test('the agent that completed a ticket may reopen it; a third agent cannot', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const creator = await registerAgent(srv.base);
  const worker = await registerAgent(srv.base);
  const third = await registerAgent(srv.base);

  const ticket = await createTicket(srv.base, creator.token, { title: 'completed then reopened' });

  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} });
  await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} });
  const done = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
    token: worker.token,
    body: { result: 'first attempt' },
  });
  assert.equal(done.status, 200);

  const bystander = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/reopen`, { token: third.token, body: {} });
  assert.equal(bystander.status, 403);
  assert.equal(errorCode(bystander), 'NOT_ASSIGNEE');

  const reopened = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/reopen`, { token: worker.token, body: {} });
  assert.equal(reopened.status, 200, 'the agent that completed the ticket may reopen it');
  assert.equal(reopened.body.ticket.state, 'open');
  assert.equal(reopened.body.ticket.assignee_id, null);
  assert.equal(reopened.body.ticket.closed_at, null);

  // And it can be picked up and finished again.
  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/claim`, { token: worker.token, body: {} })).status, 200);
  assert.equal((await api(srv.base, 'POST', `/api/tickets/${ticket.id}/start`, { token: worker.token, body: {} })).status, 200);
  const again = await api(srv.base, 'POST', `/api/tickets/${ticket.id}/complete`, {
    token: worker.token,
    body: { result: 'second attempt' },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.ticket.result, 'second attempt');
});
