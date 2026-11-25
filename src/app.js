/**
 * Application wiring: database, migrations, routes, request pipeline.
 *
 * Deliberately separated from server.js so tests can build an app, listen on an
 * ephemeral port and tear it down without spawning a process.
 */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from './db/driver.js';
import { migrate } from './db/migrate.js';
import { seedDemoAgents } from './db/seed.js';
import { configureTickets, DEFAULT_LEASE_MS } from './domain/tickets.js';
import { logRequest, authenticateRequest } from './http/middleware.js';
import { ERROR_CODES, ApiError, errorBody, json, newRequestId, readJsonBody, sendError } from './http/responses.js';
import { Router } from './http/router.js';
import { serveStatic } from './http/static.js';

import * as activityRoutes from './routes/activity.js';
import * as agentRoutes from './routes/agents.js';
import * as commentRoutes from './routes/comments.js';
import * as healthRoutes from './routes/health.js';
import * as ticketRoutes from './routes/tickets.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PUBLIC_DIR = join(HERE, '..', 'public');
export const DEFAULT_DB_PATH = process.env.DB_PATH ?? 'data/agent-tickets.db';

function leaseMsFromEnv() {
  const minutes = process.env.LEASE_MINUTES;
  if (!minutes) return DEFAULT_LEASE_MS;
  const parsed = Number(minutes);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LEASE_MS;
  return Math.round(parsed * 60 * 1000);
}

export function buildRouter() {
  const router = new Router();
  for (const routes of [healthRoutes, agentRoutes, ticketRoutes, commentRoutes, activityRoutes]) {
    routes.register(router);
  }
  return router;
}

export async function createApp({
  dbPath = DEFAULT_DB_PATH,
  driver = process.env.DB_DRIVER ?? 'auto',
  seed = process.env.SEED !== '0',
  logger = console,
  leaseMs,
} = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  const db = await openDatabase({ dbPath, driver, logger });
  const migration = migrate(db, { logger });
  const ticketConfig = configureTickets({ leaseMs: leaseMs ?? leaseMsFromEnv() });
  const seeded = seed ? seedDemoAgents(db, { logger }) : [];

  const router = buildRouter();
  const pipeline = { db, router, logger };

  const server = createServer((req, res) => {
    handleRequest({ ...pipeline, req, res }).catch((error) => {
      logger.error?.(`[error] request pipeline failure: ${error?.stack ?? error}`);
      try {
        json(res, 500, errorBody(ERROR_CODES.INTERNAL_ERROR, 'unexpected server error', null));
      } catch {
        // socket already gone
      }
    });
  });

  const close = async () => {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    db.close();
  };

  return {
    server,
    db,
    router,
    dbPath,
    driver: db.name,
    migration,
    seeded,
    leaseMs: ticketConfig.leaseMs,
    close,
  };
}

async function handleRequest({ req, res, db, router, logger }) {
  const requestId = newRequestId();
  const startedAt = Date.now();
  const method = String(req.method ?? 'GET').toUpperCase();
  let pathname = '/';

  res.setHeader('x-request-id', requestId);
  res.setHeader('x-content-type-options', 'nosniff');

  let status = 500;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    pathname = url.pathname;

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      status = await handleApi({ req, res, db, router, logger, requestId, url, pathname });
    } else if (method === 'GET' || method === 'HEAD') {
      if (serveStatic(PUBLIC_DIR, pathname, res)) {
        status = 200;
      } else {
        status = 404;
        json(res, 404, errorBody(ERROR_CODES.NOT_FOUND, 'no such file', requestId));
      }
    } else {
      status = 404;
      json(res, 404, errorBody(ERROR_CODES.NOT_FOUND, 'unknown endpoint', requestId));
    }
  } catch (error) {
    status = sendError(res, error, requestId, logger);
  } finally {
    logRequest(logger, { method, path: pathname, status, durationMs: Date.now() - startedAt, requestId });
  }
}

async function handleApi({ req, res, db, router, logger, requestId, url, pathname }) {
  const method = String(req.method ?? 'GET').toUpperCase();

  const match = router.match(method, pathname);
  if (!match) {
    req.resume();
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'unknown endpoint');
  }

  let agent = null;
  if (!match.route.public) {
    try {
      agent = authenticateRequest(db, req);
    } catch (error) {
      req.resume();
      throw error;
    }
  }

  const carriesBody = method === 'POST' || method === 'PATCH' || method === 'PUT';
  const body = carriesBody ? await readJsonBody(req) : null;

  const ctx = {
    req,
    res,
    db,
    logger,
    requestId,
    agent,
    params: match.params,
    query: url.searchParams,
    body,
    idempotencyKey: headerValue(req, 'idempotency-key'),
  };

  const status = await match.route.handler(ctx);
  return typeof status === 'number' ? status : 200;
}

function headerValue(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
