/**
 * Test harness: a real HTTP server on an ephemeral port backed by a real SQLite
 * file in a throwaway directory. Nothing is mocked - the persistence layer under
 * test is the same one production uses.
 *
 * This file is a library, not a suite: it has no tests of its own.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

const QUIET_LOGGER = { log() {}, warn() {}, error() {} };

let counter = 0;

export function uniqueName(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export async function startServer({ leaseMs, sweepIntervalMs = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-tickets-test-'));
  const dbPath = join(directory, 'test.db');

  const app = await createApp({
    dbPath,
    driver: process.env.DB_DRIVER ?? 'auto',
    seed: false,
    logger: QUIET_LOGGER,
    leaseMs,
    // Background sweeping is off by default so suites stay deterministic; the sweeper
    // test opts back in with an explicit interval.
    sweepIntervalMs,
  });

  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });

  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  return {
    base,
    app,
    db: app.db,
    dbPath,
    async close() {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function api(base, method, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  let payload;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  const response = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await response.text();

  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  return { status: response.status, body: parsed, headers: response.headers };
}

export async function registerAgent(base, options = {}) {
  const payload = { name: options.name ?? uniqueName('agent'), role: options.role ?? 'worker' };
  if (options.description !== undefined) payload.description = options.description;
  if (options.kind !== undefined) payload.kind = options.kind;

  const response = await api(base, 'POST', '/api/agents', { body: payload });
  if (response.status !== 201) {
    throw new Error(`agent registration failed: HTTP ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

export async function createTicket(base, token, fields = {}) {
  const payload = { title: fields.title ?? uniqueName('ticket') };
  if (fields.body !== undefined) payload.body = fields.body;
  if (fields.priority !== undefined) payload.priority = fields.priority;

  const response = await api(base, 'POST', '/api/tickets', { token, body: payload });
  if (response.status !== 201) {
    throw new Error(`ticket creation failed: HTTP ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.ticket;
}

export function errorCode(response) {
  return response.body?.error?.code ?? null;
}
