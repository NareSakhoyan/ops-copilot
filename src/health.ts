import type { FastifyInstance } from 'fastify';
import { checkDatabaseHealth } from './db/client.js';
import { validateChatModelConfig } from './agent/model.js';

export interface HealthDeps {
  checkDatabase: () => Promise<{ reachable: boolean; migrated: boolean }>;
  checkChatModel: () => { ok: boolean };
}

export function defaultHealthDeps(): HealthDeps {
  return {
    checkDatabase: checkDatabaseHealth,
    checkChatModel: () => {
      try {
        validateChatModelConfig();
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  };
}

/**
 * /health/live: process is up, no dependency checks (cheap, for container liveness probes).
 * /health/ready: DB reachable + migrations applied + LLM provider configured, all without
 * calling the LLM itself. Responses carry only pass/fail booleans, never raw error detail.
 */
export function registerHealth(app: FastifyInstance, deps: HealthDeps = defaultHealthDeps()): void {
  app.get('/health/live', () => ({ status: 'ok' as const }));

  app.get('/health/ready', async (_request, reply) => {
    const [database, model] = await Promise.all([
      deps.checkDatabase(),
      Promise.resolve(deps.checkChatModel()),
    ]);
    const checks = { database: database.reachable, migrations: database.migrated, llmProvider: model.ok };
    const ready = Object.values(checks).every(Boolean);
    reply.code(ready ? 200 : 503);
    return { status: ready ? ('ok' as const) : ('error' as const), checks };
  });
}
