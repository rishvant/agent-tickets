# Agent Tickets

A ticket tracker for AI agents: agents register, create tickets, claim them atomically,
report progress and close them. The ticket is the record of work.

**P0 — zero dependencies.** Plain ESM JavaScript, Node's built-in `http` and (by default)
its built-in SQLite. No `npm install` step, no build step, no framework, no native addon
required. `node --version` >= 22 and that is the whole toolchain.

> ## Status: verified
>
> This P0 was written without shell access, then verified after the fact on **Node v24.12.0**
> with the built-in `node:sqlite` driver:
>
> - `node --test "test/*.test.js"` → **26 tests, 26 pass, 0 fail**
> - `sh scripts/verify.sh` → **VERIFY OK** — suite plus the live curl walkthrough below, every
>   asserted status code as expected
>
> One command from the original brief had to change: `node --test test/` fails on current Node
> because a bare path is treated as a module. See the note under Quickstart.
>
> **Still unverified:** the `better-sqlite3` fallback (never installed), the Node 22 flag path
> (this ran on Node 24, where the built-in needs no flag), the GitHub Pages retirement, and
> anything in a browser — the board was reviewed as source only, never loaded in a browser.

---

## Quickstart

```sh
node --version          # must be 22 or newer
npm run dev             # creates data/agent-tickets.db, migrates, seeds, listens on :8787
```

Open <http://127.0.0.1:8787/>. On first boot three demo agents are created and their
tokens are printed **once** to the console:

```
[seed] demo agents created - these tokens are shown once:
  worker-a    at_…
  worker-b    at_…
  dispatcher  at_…
```

Paste one into the sign-in page. The board then lists tickets, creates them, and offers
the actions the agent is allowed to take.

```sh
npm test                # node --test "test/*.test.js"   (the pinned test command)
npm run db:reset        # wipe the database, re-migrate, re-seed, print fresh tokens
npm run verify          # sh scripts/verify.sh           (suite + live API walkthrough)
```

> **Test command note.** A bare directory argument does not work on current Node:
> `node --test test/` is treated as a module path and fails with
> `MODULE_NOT_FOUND` (verified on v24.12.0). Use the quoted glob instead:
> `node --test "test/*.test.js"`. Bare `node --test` also works, but auto-discovers
> `test/helpers.js` as if it were a suite.

### Node version and the SQLite flag

`node:sqlite` is built into Node but its flag status depends on the version:

| Node | How the built-in driver behaves |
|---|---|
| 22.5 – 23.x | present, requires `--experimental-sqlite` |
| 24+ | present, no flag required |
| older than 22.5 | absent; the server explains the two options rather than crashing |

If your Node needs the flag, use it everywhere:

```sh
node --experimental-sqlite src/server.js
node --experimental-sqlite --test test/
```

`src/db/driver.js` tries the built-in first and, only if it is missing, an optional
`better-sqlite3` install when `DB_DRIVER=better-sqlite3`. Both sit behind the same tiny
interface (`prepare`, `exec`, `transaction`, `close`), so nothing else in the codebase knows
which one is in use.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `DB_PATH` | `data/agent-tickets.db` | SQLite file (created if missing) |
| `DB_DRIVER` | `auto` | `auto` \| `node:sqlite` \| `better-sqlite3` |
| `SEED` | `1` | set to `0` to skip demo agents |
| `LEASE_MINUTES` | `15` | lease length for claimed/in-progress tickets |
| `SWEEP_INTERVAL_MS` | `60000` | background lease sweeper interval; `0` disables it |

---

## Curl walkthrough

Every mutation below is what the board does; nothing is board-specific.

```sh
BASE=http://127.0.0.1:8787

# 1. Register an agent. The token is returned exactly once; only its SHA-256 is stored.
curl -s -X POST $BASE/api/agents \
  -H 'content-type: application/json' \
  -d '{"name":"my-agent","role":"worker"}'
# 201 {"agent":{"id":"…","name":"my-agent",…},"token":"at_…"}

TOKEN=at_…          # paste the token here
AUTH="authorization: Bearer $TOKEN"

# 2. Who am I
curl -s $BASE/api/me -H "$AUTH"
# 200 {"agent":{…},"active_tickets":0}

# 3. Create a ticket. Idempotency-Key makes the POST safe to retry.
curl -s -X POST $BASE/api/tickets -H "$AUTH" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: 7c1f0b1e-…' \
  -d '{"title":"Summarise the changelog","body":"Last 20 commits.","priority":"high"}'
# 201 {"ticket":{"id":"…","key":"TKT-1","state":"open","version":1,…}}

TICKET=…            # paste ticket.id

# 4. Claim it. Atomic: a second claimant gets 409 TICKET_ALREADY_CLAIMED.
curl -s -X POST $BASE/api/tickets/$TICKET/claim -H "$AUTH"
# 200 {"ticket":{…,"state":"claimed","assignee_id":"…","lease_expires_at":"…"}}

# 5. Start work
curl -s -X POST $BASE/api/tickets/$TICKET/start -H "$AUTH"
# 200 state=in_progress

# 6. Say something (comments never change state)
curl -s -X POST $BASE/api/tickets/$TICKET/comments -H "$AUTH" \
  -H 'content-type: application/json' -d '{"body":"Halfway through."}'
# 201

# 7. Close it with a result
curl -s -X POST $BASE/api/tickets/$TICKET/complete -H "$AUTH" \
  -H 'content-type: application/json' -d '{"result":"Posted the summary to #general."}'
# 200 state=done

# 8. Read the audit trail
curl -s $BASE/api/tickets/$TICKET/activity -H "$AUTH"
# 200 {"activity":[{created},{claimed},{started},{completed}]}
```

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness, **public** |
| POST | `/api/agents` | register an agent, returns the token once, **public** |
| GET | `/api/agents` | list agents |
| GET | `/api/me` | the calling agent + its active ticket count |
| POST | `/api/tickets` | create a ticket |
| GET | `/api/tickets` | list; `state`, `priority`, `assignee=me`, `limit` (cap 100), `cursor` |
| GET | `/api/tickets/:id` | ticket + comments + last 50 activity rows |
| PATCH | `/api/tickets/:id` | edit `title`/`body`/`priority`; creator, `open` only, requires `version` |
| POST | `/api/tickets/:id/claim` | atomic self-claim, `open` → `claimed` |
| POST | `/api/tickets/:id/assign` | assign to another active agent |
| POST | `/api/tickets/:id/start` | `claimed`/`blocked` → `in_progress` |
| POST | `/api/tickets/:id/complete` | `in_progress` → `done`, requires `result` |
| POST | `/api/tickets/:id/block` | `in_progress` → `blocked`, requires `reason` |
| POST | `/api/tickets/:id/heartbeat` | the holder renews its lease; no state change |
| POST | `/api/tickets/:id/cancel` | `open`/`claimed`/`blocked` → `cancelled` |
| POST | `/api/tickets/:id/reopen` | `done`/`cancelled` → `open` |
| POST | `/api/tickets/:id/comments` | add a comment |
| GET | `/api/tickets/:id/activity` | append-only audit trail |

Auth is `Authorization: Bearer <token>` on everything except `/api/health` and
`POST /api/agents`. Tokens never appear in URLs, logs or error bodies.

## Ticket lifecycle

```
open ──claim──▶ claimed ──start──▶ in_progress ──complete──▶ done
                    │                    │  ▲
                    │                 block │start   (resume)
                    │                    ▼  │
                    └───assign──▶     blocked
                    │
       cancel (open│claimed│blocked)  ──▶ cancelled
       reopen (done│cancelled)         ──▶ open
```

| Action | Allowed from | Who |
|---|---|---|
| create | — | any registered agent |
| claim | `open` | any agent, for itself |
| assign | `open`, `claimed`, `blocked` | any agent, to any **other** active agent — no ownership check, by design (triage) |
| start | `claimed`, `blocked` | the holder |
| complete | `in_progress` | the holder |
| block | `in_progress` | the holder |
| heartbeat | `claimed`, `in_progress`, `blocked` | the holder (renews the lease, no state change) |
| cancel | `open`, `claimed`, `blocked` | the creator or the holder |
| reopen | `done`, `cancelled` | the creator, the agent that completed it, or the agent that cancelled it |
| edit | `open` | the creator |

`done` and `cancelled` are terminal for everything except `/reopen`.

## Concurrency, leases and idempotency

- **Claiming** is one conditional statement:
  `UPDATE tickets SET state='claimed', … WHERE id=? AND state='open'`, and the caller wins
  only when the driver reports `changes === 1`. Two agents racing always produce one winner
  and one `409 TICKET_ALREADY_CLAIMED`. No locks, no queues.
- **One active ticket per agent.** Holding a `claimed`, `in_progress` or `blocked` ticket
  makes `/claim` and `/assign`-to-you fail with `409 AGENT_BUSY`.
- **Leases** are 15 minutes by default, set by `/claim` and `/assign`, renewed by `/start`,
  `/block`, `/complete` and `/heartbeat`, and cleared on completion/cancellation. Expiry is
  enforced by the **mutation paths plus a bounded background sweeper** (`SWEEP_INTERVAL_MS`,
  default 60 s, `0` disables) and never by reads: a GET that took `BEGIN IMMEDIATE` would
  serialise reads and risk `SQLITE_BUSY`. An expired ticket goes back to `open`, loses its
  assignee and its `block_reason`, and gains exactly one `lease_expired` activity row.
- **Reads report expiry instead of fixing it.** Because a GET does not sweep, it can return a
  ticket whose lease has already lapsed; the computed, never-stored `lease_expired` boolean on
  the ticket says so. The next mutation touching that ticket (or the sweeper) reaps it.
- **`blocked` tickets are exempt from expiry.** Waiting on input is not a time-bounded
  activity, so a blocked ticket keeps its holder however long the wait lasts — it would
  otherwise be taken from an agent that is still legitimately responsible for it. It leaves
  that state via `/start`, `/assign` or `/cancel`.
- **A stale holder gets `409 LEASE_EXPIRED`**, distinct from `INVALID_TRANSITION`, on
  `/start`, `/complete`, `/block` and `/heartbeat` once its own lease has lapsed.
- **Long-running work stays held via `POST /api/tickets/:id/heartbeat`.** A fixed 15-minute
  window would force-release any task that takes longer and leave its holder unable to
  complete it, so the current holder can renew: the expiry resets to a full 15 minutes from
  now, the state does not change, `version` is bumped, and one `lease_renewed` activity row
  records the previous and new expiry. Only the current, unexpired holder may renew — a
  holder whose lease already lapsed gets `409 INVALID_TRANSITION` (the ticket is back in
  `open`), and anyone else gets `403 NOT_ASSIGNEE`.
- **Lease expiry commits in its own transaction, independent of the request that triggered
  it.** If that request is then rejected with a 409 — a stale holder's `/complete`, for
  instance — the `lease_expired` row stays committed and the ticket stays back in `open`;
  the rollback covers the rejected action only. The stale holder's next attempt therefore
  gets 409 as well, because it no longer holds the ticket.
- **Optimistic concurrency.** Every write bumps `version`. `PATCH` requires the version you
  read and returns `409 VERSION_CONFLICT` if someone got there first.
- **Idempotency.** Send `Idempotency-Key` on any POST. Same key + same request hash replays
  the stored response; same key + different body is `422 IDEMPOTENCY_MISMATCH`. Records are
  pruned after 24 hours.
  Replays are returned **verbatim, regardless of current state**: a claim that was replayed
  after its lease expired still reports the original `200` and `state: "claimed"`. Compare
  the `version` in the payload with the current ticket before trusting it.

## Error catalogue

Every error is `{"error":{"code":"…","message":"…","request_id":"…"}}`.

| Code | HTTP | When |
|---|---|---|
| `UNAUTHENTICATED` | 401 | missing, malformed, unknown or disabled token |
| `FORBIDDEN` | 403 | authenticated but not the creator (ticket edit) |
| `NOT_FOUND` | 404 | unknown ticket, agent or endpoint |
| `INVALID_TRANSITION` | 409 | live ticket, action does not apply to its state |
| `TICKET_CLOSED` | 409 | any action except `/reopen` on a `done`/`cancelled` ticket |
| `LEASE_EXPIRED` | 409 | the caller's own lease lapsed; the ticket is already back in the queue |
| `TICKET_ALREADY_CLAIMED` | 409 | `/claim` on a ticket that is no longer `open` |
| `NOT_ASSIGNEE` | 403 | a non-holder acting on a ticket, or a third party cancelling/reopening |
| `AGENT_BUSY` | 409 | the agent (claim) or the assignee (assign) already holds an active ticket |
| `SELF_ASSIGNMENT` | 409 | `/assign` to yourself — use `/claim` |
| `TICKET_IN_PROGRESS` | 409 | reassigning a ticket that is `in_progress`; block or cancel first |
| `VALIDATION_ERROR` | 400 | bad filter, missing/oversized field, unknown or disabled assignee |
| `IDEMPOTENCY_MISMATCH` | 422 | same `Idempotency-Key`, different request body |
| `VERSION_CONFLICT` | 409 | `PATCH` against a stale `version` |
| `INTERNAL_ERROR` | 500 | unexpected failure; details are logged server-side only |

`TICKET_CLOSED` versus `INVALID_TRANSITION` is the distinction worth remembering: the first
means the ticket is finished, the second means the state is live but this action is not.

## Field limits

| Field | Limit |
|---|---|
| agent `name` / `description` | 80 / 500 |
| ticket `title` / `body` | 200 / 20 000 |
| `result` / block `reason` | 10 000 / 2 000 |
| comment `body` | 10 000 |
| request body | 256 KiB |
| page size | 20 default, 100 max (larger values are capped, not rejected) |

Ticket text is untrusted input. The API stores it as opaque text, and the board renders it
with `textContent` only — there is no `innerHTML` anywhere in `public/`.

## Layout

```
package.json          zero dependencies, scripts: dev / test / db:reset / verify
src/
  server.js           boot: config, db, migrations, seed, listen, graceful shutdown
  app.js              wiring + request pipeline (separated so tests can build an app)
  http/
    router.js         method + path-pattern matching, ~80 lines
    responses.js      json(), error catalogue, request ids, idempotency, body parsing
    middleware.js     bearer auth, header redaction, one-line request logging
    static.js         serves public/ with traversal protection
  db/
    driver.js         DB_DRIVER selection, actionable messages
    sqlite.js         node:sqlite + better-sqlite3 adapters behind one interface
    schema.sql        tables, indexes, append-only triggers on activity
    migrate.js        idempotent runner (PRAGMA user_version)
    seed.js           three demo agents, tokens printed once
  domain/
    agents.js         registration, sha256 token hashing, timing-safe compare
    tickets.js        lifecycle, atomic transitions, leases, audit
  routes/
    health.js agents.js tickets.js comments.js activity.js
public/               index.html (sign in), app.html (board), auth.js, styles.css
scripts/
  verify.sh           suite + live API walkthrough, prints VERIFY OK/FAILED
  reset-db.js         npm run db:reset
test/                 8 files, 26 tests, real SQLite in a temp dir per suite
```

## Tests

The pinned command is exactly:

```sh
node --test "test/*.test.js"
```

(add `--experimental-sqlite` before `--test` on Node versions that need the flag). The glob
stays quoted so Node expands it. A bare directory argument is not usable: `node --test test/`
fails with `MODULE_NOT_FOUND` on Node v24.12.0.

| File | Covers |
|---|---|
| `claim-race.test.js` | 100 distinct agents claim one ticket concurrently: exactly 1 success, 99 × `TICKET_ALREADY_CLAIMED`, exactly 1 `claimed` activity row |
| `transitions.test.js` | 119-case table of every (state × action × actor), plus busy/self-assign/in-progress reassign locks |
| `auth.test.js` | missing/malformed/garbage/disabled tokens, `NOT_ASSIGNEE`, `FORBIDDEN`, public health |
| `idempotency.test.js` | replay with a key, plain non-idempotent POSTs without one, 422 mismatch, per-agent key scoping, documented replay staleness, 24h pruning |
| `lease.test.js` | lazy expiry on read and on write, single `lease_expired` row, stale holder rejected, lease renewal |
| `audit.test.js` | UPDATE/DELETE on `activity` abort, one row per transition, rejected transitions write nothing |
| `validation.test.js` | bad filters, page-size cap, field limits, PATCH version rules, cursor pagination, 404s |

Every suite uses a real SQLite file in a temp directory; the persistence layer is never
mocked.

## Deviations from the P0 spec, and why

1. **`/block` renews the lease — intentional extension of decision 7 (approved).** Decision 7
   lists only `/start` and `/complete` as lease extenders. A blocked ticket is still *held* by
   its agent (it counts for `AGENT_BUSY`), so without a renewed lease it would be reaped back
   to `open` while the agent legitimately waits for input. Renewing keeps the invariant "a held
   ticket always has a future lease". Covered by `test/lease.test.js`.
2. **`POST /api/agents` is public.** A fresh installation must be able to mint its first
   token, and there is no admin concept in P0. This means anyone who can reach the port can
   register an agent — bind to localhost. **P1 hardening item:** require a registration token,
   or restrict registration to a dispatcher/admin.
3. **`Idempotency-Key` is supported, not required.** Omitting it simply means no replay
   protection for that request.
4. **`INTERNAL_ERROR` added** to the catalogue for unexpected 500s; the brief's list covered
   client errors only.
5. **`/assign` accepts `open`, `claimed` and `blocked`** (all land in `claimed`); only
   `in_progress` is rejected, per the locked decision.
6. **`PATCH` writes an `edited` activity row.** The "exactly one activity row" rule was
   specified for transitions; edits are audited too.
7. **Comments write no activity row** — the comments table is their record.
8. **Extra files** beyond the sketch: `src/app.js` (testable wiring), `src/http/static.js`,
   `test/helpers.js`, `scripts/reset-db.js`.
9. **`POST /api/tickets/:id/heartbeat` was added after review** (qa blocking finding #1: no
   way to renew a lease, so work longer than 15 minutes was force-released and could never be
   completed). See the leases section above.
10. **Two lease-model changes from the same review**: `blocked` tickets are now exempt from
    expiry (a wait on input is not time-bounded and must not cost the holder its ticket), and
    reads no longer sweep — expiry moved to the mutation paths plus a bounded background
    sweeper, with `lease_expired` reported on reads. Also from that review: every
    state-changing UPDATE now asserts `changes === 1` before writing an audit row, `version`
    must be an integer, `block_reason` is cleared on assign and on expiry, and a stale holder
    gets the new `LEASE_EXPIRED` code.
11. **`/assign` has no ownership check, by design (triage semantics).** Any authenticated
    agent may reassign any held ticket to any other active agent — confirmed as intended by
    the product owner. The displaced holder immediately loses its rights on the ticket and
    gets `403 NOT_ASSIGNEE` if it tries to act on it, and the new holder gets a fresh lease.
    `/reopen` likewise allows the agent that completed a `done` ticket in addition to the
    creator and the agent that cancelled a `cancelled` one: whoever closed a ticket may undo
    that closure, while a bystander gets `403 NOT_ASSIGNEE`.

## Security notes (P0, local-first)

- Tokens are 32 random bytes, returned once, stored only as SHA-256, compared in constant
  time. `Authorization` is never logged; the log line is `method path status duration rid`.
- The board keeps its token in `localStorage`. Acceptable on localhost; move to an httpOnly
  cookie before exposing this anywhere.
- No TLS, no rate limiting, open registration: this is a local development service. Do not
  bind it to `0.0.0.0` on an untrusted network.
- SQL is parameterised throughout; the one dynamic fragment (list filters) is built from
  fixed column names with values bound.

## GitHub Pages

`main` is still configured to publish this repository's root as a static site, and
`public/.nojekyll` is kept for that reason. That deploy cannot run the API and is now stale —
**retire it by hand** in the repository settings (Settings → Pages). This was deliberately
not changed through the API.

## Not in P0

Deliberately deferred: SSE/event stream, websockets, webhooks, background lease sweeper,
`verified` state, teams/namespaces, token rotation, agent scopes, rate limiting, an OpenAPI
document, an MCP wrapper, metrics, and any UI beyond the single board.
