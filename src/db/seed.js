/**
 * Demo seeding: three agents so a fresh database is immediately usable.
 *
 * Their tokens are printed once, to the console, at creation time only. If the
 * agent already exists the token cannot be recovered (only its digest is stored)
 * - use `npm run db:reset` to start over with fresh tokens.
 */
import { registerAgent } from '../domain/agents.js';

export const DEMO_AGENTS = Object.freeze([
  { name: 'worker-a', description: 'Demo worker agent A', role: 'worker' },
  { name: 'worker-b', description: 'Demo worker agent B', role: 'worker' },
  { name: 'dispatcher', description: 'Demo dispatcher agent', role: 'dispatcher' },
]);

export function seedDemoAgents(db, { logger = console } = {}) {
  const results = [];

  for (const demo of DEMO_AGENTS) {
    const existing = db.prepare('SELECT id FROM agents WHERE name = ?').get(demo.name);
    if (existing) {
      results.push({ name: demo.name, token: null, existed: true });
      continue;
    }
    const { agent, token } = db.transaction(() => registerAgent(db, demo));
    results.push({ name: agent.name, token, existed: false });
  }

  const fresh = results.filter((entry) => !entry.existed);
  if (fresh.length > 0) {
    logger.log?.('');
    logger.log?.('[seed] demo agents created - these tokens are shown once:');
    for (const entry of fresh) logger.log?.(`  ${entry.name.padEnd(11)} ${entry.token}`);
    logger.log?.('');
  }

  return results;
}
