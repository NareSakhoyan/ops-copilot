import { setTimeout } from 'node:timers/promises';
import { and, eq, lt, sql } from 'drizzle-orm';
import { computeBackoffMs } from '../net/retry.js';
import type { RequestContext } from '../auth/context.js';
import type { TenantDatabase, TenantTransaction } from '../db/client.js';
import { pendingActions } from '../db/schema/approvals.js';
import type { MockBitrix } from '../mock-bitrix/service.js';
import { writeAudit } from '../observability/audit.js';
import { HttpError } from '../routes/errors.js';

type Action = typeof pendingActions.$inferSelect;

export async function claimExecution(tx: TenantTransaction, ctx: RequestContext, id: string): Promise<Action> {
  const [action] = await tx.update(pendingActions).set({ status: 'executing' }).where(and(
    eq(pendingActions.tenantId, ctx.tenantId), eq(pendingActions.id, id), eq(pendingActions.status, 'approved'),
  )).returning();
  if (!action) throw new HttpError(409, 'Action was already claimed');
  await writeAudit(tx, ctx, { action: 'approval.executing', entityType: 'pending_action', entityId: id, metadata: { from: 'approved', to: 'executing' } });
  return action;
}

export async function executeApproval(database: TenantDatabase, mock: MockBitrix, ctx: RequestContext, action: Action): Promise<Action> {
  const tenant = { tenant_id: ctx.tenantId, user_id: ctx.userId };
  const where = and(eq(pendingActions.tenantId, ctx.tenantId), eq(pendingActions.id, action.id), eq(pendingActions.status, 'executing'));

  async function finish(status: 'executed' | 'failed', error: string | null): Promise<Action> {
    return database.withTenant(tenant, async (tx) => {
      const [result] = await tx.update(pendingActions).set({ status, error, executedAt: status === 'executed' ? new Date() : null }).where(where).returning();
      if (!result) throw new HttpError(409, 'Action is no longer executing');
      await writeAudit(tx, ctx, { action: `approval.${status}`, entityType: 'pending_action', entityId: action.id, metadata: { from: 'executing', to: status, attempts: result.attempts, ...(status === 'executed' ? { taskId: action.id } : {}) } });
      return result;
    });
  }

  for (;;) {
    const attempted = await database.withTenant(tenant, async (tx) => {
      const [result] = await tx.update(pendingActions).set({ attempts: sql`${pendingActions.attempts} + 1` })
        .where(and(where, lt(pendingActions.attempts, 3))).returning();
      if (!result) throw new HttpError(409, 'Action has no remaining attempts');
      await writeAudit(tx, ctx, { action: 'approval.attempted', entityType: 'pending_action', entityId: action.id, metadata: { attempt: result.attempts } });
      return result;
    });
    try {
      await mock.addTask(ctx, action.id, action.payload);
    } catch (error: unknown) {
      const retry = error instanceof HttpError && error.statusCode >= 500 && attempted.attempts < 3;
      const message = error instanceof HttpError ? error.message : 'Task execution failed';
      await database.withTenant(tenant, async (tx) => {
        await tx.update(pendingActions).set({ error: message }).where(where);
        await writeAudit(tx, ctx, { action: 'approval.attempt_failed', entityType: 'pending_action', entityId: action.id, metadata: { attempt: attempted.attempts, retry } });
      });
      if (!retry) return finish('failed', message);
      await setTimeout(computeBackoffMs(attempted.attempts - 1, { baseMs: 250 }));
      continue;
    }
    // Audit/commit failures here must propagate; the task may already exist.
    return finish('executed', null);
  }
}
