#!/bin/sh
# One-command verification for Agent Tickets P0.
#
#   sh scripts/verify.sh        (or: npm run verify)
#
# What it does:
#   1. checks Node >= 22 and works out which SQLite driver will be used, printing
#      the exact command (including any required flag);
#   2. runs the whole test suite with node:test;
#   3. boots the server on a free port with a throwaway database, curls the full
#      happy path (register -> create -> claim -> start -> complete -> activity),
#      asserts every status code, and checks one failure path;
#   4. prints VERIFY OK or VERIFY FAILED <step> and exits non-zero on failure.
#
# Safe to re-run: the database lives in a temp directory and the server is always
# killed on exit (including on failure or Ctrl-C).

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

NODE_BIN=${NODE_BIN:-node}
SERVER_PID=""
TMP_DIR=""
LAST_BODY=""
RESPONSE_CODE=""

say() { printf '%s\n' "$*"; }
fail() { printf 'VERIFY FAILED: %s\n' "$1" >&2; exit 1; }

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

command -v "$NODE_BIN" >/dev/null 2>&1 || fail "node not found (set NODE_BIN=/path/to/node)"
command -v curl >/dev/null 2>&1 || fail "curl not found (the walkthrough uses curl)"

NODE_VERSION=$("$NODE_BIN" -v)
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || fail "Node 22 or newer is required, found $NODE_VERSION"

# ---------------------------------------------------------------- driver choice
NODE_FLAGS=""
DB_DRIVER=${DB_DRIVER:-auto}

if [ "$DB_DRIVER" = "better-sqlite3" ]; then
  DRIVER_LABEL="better-sqlite3 (DB_DRIVER=better-sqlite3)"
elif "$NODE_BIN" -e 'import("node:sqlite").then(function () { process.exit(0); }, function () { process.exit(1); })' >/dev/null 2>&1; then
  DRIVER_LABEL="node:sqlite (built in, no flag needed)"
elif "$NODE_BIN" --experimental-sqlite -e 'import("node:sqlite").then(function () { process.exit(0); }, function () { process.exit(1); })' >/dev/null 2>&1; then
  NODE_FLAGS="--experimental-sqlite"
  DRIVER_LABEL="node:sqlite (requires --experimental-sqlite)"
else
  fail "node:sqlite is unavailable on $NODE_VERSION and better-sqlite3 is not installed; upgrade Node or run: npm install better-sqlite3 && DB_DRIVER=better-sqlite3 sh scripts/verify.sh"
fi

say "Agent Tickets verify"
say "  node      $NODE_VERSION"
say "  storage   $DRIVER_LABEL"
say "  tests     node ${NODE_FLAGS:+$NODE_FLAGS }--test \"test/*.test.js\""
say ""

# ------------------------------------------------------------------- test suite
say "[1/3] test suite"
# Intentionally unquoted NODE_FLAGS (empty or one flag); the glob stays quoted so
# node expands it rather than the shell.
# shellcheck disable=SC2086
"$NODE_BIN" $NODE_FLAGS --test "test/*.test.js" || fail "test suite failed"
say ""

# ------------------------------------------------------------------- boot server
say "[2/3] boot the server"
TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t agent-tickets) || fail "could not create a temp directory"
LAST_BODY="$TMP_DIR/last.json"

PORT=$("$NODE_BIN" -e 'const server = require("node:net").createServer(); server.listen(0, "127.0.0.1", function () { process.stdout.write(String(server.address().port)); server.close(); });')
[ -n "$PORT" ] || fail "could not allocate a free port"

PORT="$PORT" DB_PATH="$TMP_DIR/verify.db" DB_DRIVER="$DB_DRIVER" \
  "$NODE_BIN" $NODE_FLAGS src/server.js >"$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!

ATTEMPT=0
while [ "$ATTEMPT" -lt 30 ]; do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -lt 30 ]; then sleep 1; fi
done

if [ "$ATTEMPT" -ge 30 ]; then
  printf '%s\n' '--- server log ---' >&2
  cat "$TMP_DIR/server.log" >&2 || true
  fail "server did not become healthy on port $PORT"
fi
say "  server healthy on port $PORT"
say ""

# --------------------------------------------------------------- request helper
request() {
  method="$1"
  path="$2"
  token="$3"
  data="${4-}"

  if [ -n "$data" ]; then
    RESPONSE_CODE=$(curl -sS -o "$LAST_BODY" -w '%{http_code}' -X "$method" \
      -H 'content-type: application/json' \
      -H "authorization: Bearer ${token}" \
      --data "$data" "http://127.0.0.1:${PORT}${path}")
  else
    RESPONSE_CODE=$(curl -sS -o "$LAST_BODY" -w '%{http_code}' -X "$method" \
      -H "authorization: Bearer ${token}" \
      "http://127.0.0.1:${PORT}${path}")
  fi
}

expect_code() {
  expected="$1"
  label="$2"
  if [ "$RESPONSE_CODE" != "$expected" ]; then
    printf '  response body: %s\n' "$(cat "$LAST_BODY" 2>/dev/null || true)" >&2
    fail "$label: expected HTTP $expected, got $RESPONSE_CODE"
  fi
  say "  ok  $label (HTTP $expected)"
}

json_field() {
  "$NODE_BIN" -e '
    let input = "";
    process.stdin.on("data", function (chunk) { input += chunk; });
    process.stdin.on("end", function () {
      let value = {};
      try { value = input.length ? JSON.parse(input) : {}; } catch (error) { value = {}; }
      const keys = process.argv[1].split(".");
      for (const key of keys) {
        value = value === null || value === undefined ? undefined : value[key];
      }
      process.stdout.write(value === undefined || value === null ? "" : String(value));
    });
  ' "$1" < "$LAST_BODY"
}

# ------------------------------------------------------------- happy path walk
say "[3/3] curl walkthrough"

request POST /api/agents "none" '{"name":"verify-agent"}'
expect_code 201 "register agent"
TOKEN=$(json_field token)
[ -n "$TOKEN" ] || fail "register agent: no token in the response"
case "$TOKEN" in
  at_*) : ;;
  *) fail "register agent: token does not start with at_" ;;
esac

request GET /api/me "$TOKEN"
expect_code 200 "whoami"

request GET /api/agents "$TOKEN"
expect_code 200 "list agents"
AGENT_COUNT=$(json_field agents.length)
[ "$AGENT_COUNT" -ge 4 ] || fail "list agents: expected at least 4 agents (3 seeded + 1 registered), got $AGENT_COUNT"

request POST /api/tickets "$TOKEN" '{"title":"verify: end to end","body":"created by scripts/verify.sh","priority":"high"}'
expect_code 201 "create ticket"
TICKET_ID=$(json_field ticket.id)
[ -n "$TICKET_ID" ] || fail "create ticket: no id in the response"

request POST "/api/tickets/${TICKET_ID}/claim" "$TOKEN" '{}'
expect_code 200 "claim ticket"
LEASED_STATE=$(json_field ticket.state)
[ "$LEASED_STATE" = "claimed" ] || fail "claim ticket: expected state claimed, got $LEASED_STATE"

request POST "/api/tickets/${TICKET_ID}/start" "$TOKEN" '{}'
expect_code 200 "start ticket"

request POST "/api/tickets/${TICKET_ID}/complete" "$TOKEN" '{"result":"verified end to end"}'
expect_code 200 "complete ticket"
FINAL_STATE=$(json_field ticket.state)
[ "$FINAL_STATE" = "done" ] || fail "complete ticket: expected state done, got $FINAL_STATE"

request POST "/api/tickets/${TICKET_ID}/complete" "$TOKEN" '{"result":"second attempt"}'
expect_code 409 "reject double completion"
CLOSED_CODE=$(json_field error.code)
[ "$CLOSED_CODE" = "TICKET_CLOSED" ] || fail "reject double completion: expected TICKET_CLOSED, got $CLOSED_CODE"

request GET "/api/tickets/${TICKET_ID}/activity" "$TOKEN"
expect_code 200 "activity trail"
ACTIVITY_COUNT=$(json_field activity.length)
[ "$ACTIVITY_COUNT" = "4" ] || fail "activity trail: expected 4 rows (created, claimed, started, completed), got $ACTIVITY_COUNT"

request GET /api/me "not-a-real-token"
expect_code 401 "reject a bad token"
AUTH_CODE=$(json_field error.code)
[ "$AUTH_CODE" = "UNAUTHENTICATED" ] || fail "reject a bad token: expected UNAUTHENTICATED, got $AUTH_CODE"

say ""
say "VERIFY OK  ($NODE_VERSION, $DRIVER_LABEL)"
say "  suite passed, and the API happy path returned the expected status codes"
