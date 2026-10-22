import { and, desc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import type { RequestContext } from '../auth/context.js';
import { can } from '../auth/rbac.js';
import type { TenantDatabase } from '../db/client.js';
import { pendingActions } from '../db/schema/approvals.js';
import type { MockBitrix } from '../mock-bitrix/service.js';
import { writeAudit } from '../observability/audit.js';
import { HttpError } from '../routes/errors.js';
import { claimExecution, executeApproval } from './executor.js';
import { approvalVisibility, assertAssignee, assertDecision, freshContext } from './policy.js';
import { approvalListSchema, proposalSchema, taskPayloadSchema } from './schema.js';

export function createApprovalsService(database: TenantDatabase, mock: MockBitrix) {
  async function createProposal(ctx: RequestContext, input: unknown) {
    const proposal = proposalSchema.parse(input);
    return database.withTenant({ tenant_id: ctx.tenantId, user_id: ctx.userId }, async (tx) => {
      const current = await freshContext(tx, ctx);
      await assertAssignee(tx, current, proposal.payload);
      const [action] = await tx.insert(pendingActions).values({ tenantId: current.tenantId, userId: current.userId, ...proposal }).returning();
      if (!action) throw new Error('Proposal insert returned no row');
      await writeAudit(tx, current, { action: 'approval.created', entityType: 'pending_action', entityId: action.id, metadata: { to: 'pending' } });
      return action;
    });
  }

  async function list(ctx: RequestContext, input: unknown = {}) {
    const query = approvalListSchema.parse(input);
    return database.withTenant({ tenant_id: ctx.tenantId, user_id: ctx.userId }, async (tx) => {
      const current = await freshContext(tx, ctx);
      if (!can(current, 'approvals:read')) throw new HttpError(403, 'Approval listing is not permitted');
      return tx.select().from(pendingActions).where(and(
        approvalVisibility(current), eq(pendingActions.status, query.status),
        query.status === 'pending' || query.status === 'approved' ? gt(pendingActions.expiresAt, new Date()) : undefined,
      )).orderBy(desc(pendingActions.createdAt), desc(pendingActions.id)).limit(query.limit).offset(query.offset);
    });
  }

  async function decide(ctx: RequestContext, inputId: string, decision: 'approve' | 'reject') {
    const id = z.uuid().parse(inputId);
    const result = await database.withTenant({ tenant_id: ctx.tenantId, user_id: ctx.userId }, async (tx) => {
      const current = await freshContext(tx, ctx);
      const [stored] = await tx.select().from(pendingActions).where(and(eq(pendingActions.tenantId, current.tenantId), eq(pendingActions.id, id))).for('update');
      if (!stored) throw new HttpError(404, 'Approval not found');
      const requester = await freshContext(tx, current, stored.userId);
      assertDecision(current, requester);
      let action = stored;
      if ((action.status === 'pending' || action.status === 'approved') && action.expiresAt.getTime() <= Date.now()) {
        const [expired] = await tx.update(pendingActions).set({ status: 'expired' }).where(eq(pendingActions.id, id)).returning();
        if (!expired) throw new Error('Expired action disappeared');
        await writeAudit(tx, current, { action: 'approval.expired', entityType: 'pending_action', entityId: id, metadata: { from: action.status, to: 'expired' } });
        action = expired;
      }
      if (action.status === 'expired') return { action, claimed: false, ctx: current };
      if (decision === 'reject') {
        if (action.status === 'rejected') return { action, claimed: false, ctx: current };
        if (action.status !== 'pending') throw new HttpError(409, 'Only pending actions can be rejected');
        const [rejected] = await tx.update(pendingActions).set({ status: 'rejected', decidedAt: new Date() })
          .where(and(eq(pendingActions.id, id), eq(pendingActions.status, 'pending'))).returning();
        if (!rejected) throw new HttpError(409, 'Action is no longer pending');
        await writeAudit(tx, current, { action: 'approval.rejected', entityType: 'pending_action', entityId: id, metadata: { from: 'pending', to: 'rejected' } });
        return { action: rejected, claimed: false, ctx: current };
      }
      if (action.status === 'rejected') throw new HttpError(409, 'Action was rejected');
      if (action.status !== 'pending' && action.status !== 'approved') return { action, claimed: false, ctx: current };
      const payload = taskPayloadSchema.parse(action.payload);
      await assertAssignee(tx, requester, payload);
      if (current.userId !== requester.userId) await assertAssignee(tx, current, payload);
      if (action.status === 'pending') {
        const [approved] = await tx.update(pendingActions).set({ status: 'approved', decidedAt: new Date() })
          .where(and(eq(pendingActions.id, id), eq(pendingActions.status, 'pending'))).returning();
        if (!approved) throw new HttpError(409, 'Action is no longer pending');
        await writeAudit(tx, current, { action: 'approval.approved', entityType: 'pending_action', entityId: id, metadata: { from: 'pending', to: 'approved' } });
      }
      return { action: await claimExecution(tx, current, id), claimed: true, ctx: current };
    });
    if (result.action.status === 'expired') throw new HttpError(410, 'Approval has expired');
    return result.claimed ? executeApproval(database, mock, result.ctx, result.action) : result.action;
  }

  return {
    createProposal, list,
    approve: (ctx: RequestContext, id: string) => decide(ctx, id, 'approve'),
    reject: (ctx: RequestContext, id: string) => decide(ctx, id, 'reject'),
  };
}
