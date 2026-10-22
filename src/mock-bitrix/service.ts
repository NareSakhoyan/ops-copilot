import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { RequestContext } from '../auth/context.js';
import { can, scopeFilter } from '../auth/rbac.js';
import { assertAssignee, assertDecision, freshContext } from '../approvals/policy.js';
import { taskPayloadSchema } from '../approvals/schema.js';
import type { TenantDatabase } from '../db/client.js';
import { pendingActions } from '../db/schema/approvals.js';
import { contacts, deals, tasks } from '../db/schema/crm.js';
import { writeAudit } from '../observability/audit.js';
import { HttpError } from '../routes/errors.js';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  start: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();

export function createMockBitrix(database: TenantDatabase) {
  async function addTask(ctx: RequestContext, inputKey: string, input: unknown) {
    const id = z.uuid().parse(inputKey);
    const payload = taskPayloadSchema.parse(input);
    return database.withTenant({ tenant_id: ctx.tenantId, user_id: ctx.userId }, async (tx) => {
      const current = await freshContext(tx, ctx);
      const [action] = await tx.select().from(pendingActions).where(and(eq(pendingActions.tenantId, current.tenantId), eq(pendingActions.id, id))).for('update');
      if (!action) throw new HttpError(404, 'Approval not found');
      const requester = await freshContext(tx, current, action.userId);
      assertDecision(current, requester);
      if (action.status !== 'executing' && action.status !== 'executed') throw new HttpError(409, 'Task creation requires approved execution');
      if (action.type !== 'task.create' || JSON.stringify(taskPayloadSchema.parse(action.payload)) !== JSON.stringify(payload)) {
        throw new HttpError(409, 'Task fields differ from the approved proposal');
      }
      await assertAssignee(tx, requester, payload);
      if (current.userId !== requester.userId) await assertAssignee(tx, current, payload);
      const [existing] = await tx.select().from(tasks).where(and(eq(tasks.tenantId, current.tenantId), eq(tasks.id, id)));
      if (existing) {
        if (existing.title !== payload.title || existing.description !== payload.description || existing.assigneeEmployeeId !== payload.assigneeEmployeeId || existing.dueAt.toISOString() !== payload.dueAt) {
          throw new HttpError(409, 'Idempotency key is already associated with another task');
        }
        return existing;
      }
      if (action.status !== 'executing') throw new HttpError(409, 'Executed action has no task');
      const [task] = await tx.insert(tasks).values({ id, tenantId: current.tenantId, title: payload.title, description: payload.description, assigneeEmployeeId: payload.assigneeEmployeeId, dueAt: new Date(payload.dueAt) })
        .onConflictDoNothing({ target: tasks.id }).returning();
      if (!task) throw new HttpError(409, 'Task ID is already in use');
      await writeAudit(tx, current, { action: 'task.created', entityType: 'task', entityId: id, metadata: { proposalId: id, requesterUserId: requester.userId } });
      return task;
    });
  }

  async function getTask(ctx: RequestContext, inputId: string) {
    const id = z.uuid().parse(inputId);
    return database.withTenant({ tenant_id: ctx.tenantId, user_id: ctx.userId }, async (tx) => {
      const current = await freshContext(tx, ctx);
      if (!can(current, 'tasks:read')) throw new HttpError(403, 'Task reading is not permitted');
      const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, id), scopeFilter(current, 'rows', { tenantId: tasks.tenantId, employeeId: tasks.assigneeEmployeeId })));
      if (!task) throw new HttpError(404, 'Task not found');
      return task;
    });
  }

  async function listDeals(ctx: RequestContext, input: unknown = {}) {
    const query = listSchema.parse(input);
    return database.withTenant({ tenant_id: ctx.tenantId, user_id: ctx.userId }, async (tx) => {
      const current = await freshContext(tx, ctx);
      if (!can(current, 'deals:read')) throw new HttpError(403, 'Deal reading is not permitted');
      const rows = await tx.select().from(deals).where(scopeFilter(current, 'rows', { tenantId: deals.tenantId, employeeId: deals.responsibleEmployeeId }))
        .orderBy(asc(deals.createdAt), asc(deals.id)).limit(query.limit).offset(query.start);
      return rows.map((row) => ({ ID: row.id, TITLE: row.title, STAGE_ID: row.status, OPPORTUNITY: row.amount, CURRENCY_ID: row.currency, CONTACT_ID: row.contactId }));
    });
  }

  async function listContacts(ctx: RequestContext, input: unknown = {}) {
    const query = listSchema.parse(input);
    return database.withTenant({ tenant_id: ctx.tenantId, user_id: ctx.userId }, async (tx) => {
      const current = await freshContext(tx, ctx);
      if (!can(current, 'contacts:read')) throw new HttpError(403, 'Contact reading is not permitted');
      const visibleDeals = tx.select({ contactId: deals.contactId }).from(deals)
        .where(scopeFilter(current, 'rows', { tenantId: deals.tenantId, employeeId: deals.responsibleEmployeeId }));
      const rows = await tx.select().from(contacts).where(and(eq(contacts.tenantId, current.tenantId), current.roles.includes('admin') ? undefined : inArray(contacts.id, visibleDeals)))
        .orderBy(asc(contacts.createdAt), asc(contacts.id)).limit(query.limit).offset(query.start);
      return rows.map((row) => ({ ID: row.id, NAME: row.name, COMPANY_ID: row.companyId,
        EMAIL: row.email === null ? [] : [{ VALUE: row.email, VALUE_TYPE: 'WORK' }],
        PHONE: row.phone === null ? [] : [{ VALUE: row.phone, VALUE_TYPE: 'WORK' }],
      }));
    });
  }

  return { addTask, getTask, listDeals, listContacts };
}

export type MockBitrix = ReturnType<typeof createMockBitrix>;
