/**
 * Liveness probe. Public on purpose: monitoring should not need a token.
 */
import { json } from '../http/responses.js';

export function register(router) {
  router.get(
    '/api/health',
    (ctx) => {
      const row = ctx.db.prepare('SELECT 1 AS ok').get();
      json(ctx.res, 200, {
        ok: Boolean(row?.ok),
        db: ctx.db.name,
        node: process.version,
        uptime_s: Math.round(process.uptime()),
        time: new Date().toISOString(),
      });
      return 200;
    },
    { public: true },
  );
}
