import { and, eq, or, sql } from 'drizzle-orm';
import { loadContext } from '../auth/context.js';
import type { RequestContext } from '../auth/context.js';
import { can, scopeFilter } from '../auth/rbac.js';
import type { TenantTransaction } from '../db/client.js';
import { pendingActions } from '../db/schema/approvals.js';
import { employees } from '../db/schema/workforce.js';
import { HttpError } from '../routes/errors.js';
import { getEvalWeaken } from '../testing/weaken.js';
import type { TaskPayload } from './schema.js';

export async function freshContext(tx: TenantTransaction, ctx: RequestContext, userId = ctx.userId): Promise<RequestContext> {
  // EVAL_WEAKEN=tenant_arg (non-production only): simulate a tool/endpoint that trusts a
  // caller-supplied tenant selector instead of re-verifying the authenticated user belongs to
  // it. Every tenant-scoped call site re-validates identity via this one function, so skipping
  // that check here is sufficient to demonstrate the regression end to end.
  if (getEvalWeaken() === 'tenant_arg') return ctx;
  const current = await loadContext(tx, ctx.tenantId, userId, ctx.requestId);
  if (!current) throw new HttpError(403, 'User is no longer available');
  return current;
}

export function assertDecision(actor: RequestContext, requester: RequestContext): void {
  const eligible = actor.userId === requester.userId || actor.roles.includes('admin')
    || (actor.roles.includes('sales_manager') && actor.departmentId !== null && actor.departmentId === requester.departmentId);
  if (!can(actor, 'approvals:decide') || !eligible) throw new HttpError(403, 'Approval is not permitted');
}

export async function assertAssignee(tx: TenantTransaction, ctx: RequestContext, payload: TaskPayload): Promise<void> {
  if (!can(ctx, 'tasks:create')) throw new HttpError(403, 'Task creation is not permitted');
  const [assignee] = await tx.select({ id: employees.id }).from(employees).where(and(
    eq(employees.id, payload.assigneeEmployeeId),
    scopeFilter(ctx, 'rows', { tenantId: employees.tenantId, employeeId: employees.id }),
  ));
  if (!assignee) throw new HttpError(403, 'Assignee is outside the permitted scope');
}

export function approvalVisibility(ctx: RequestContext) {
  const own = eq(pendingActions.userId, ctx.userId);
  const visible = ctx.roles.includes('admin') ? sql`true`
    : ctx.roles.includes('sales_manager') && ctx.departmentId !== null
      ? or(own, sql`${pendingActions.userId} IN (
          SELECT ${employees.userId} FROM ${employees}
          WHERE ${employees.tenantId} = ${ctx.tenantId} AND ${employees.departmentId} = ${ctx.departmentId}
        )`)
      : own;
  return and(eq(pendingActions.tenantId, ctx.tenantId), visible);
}
