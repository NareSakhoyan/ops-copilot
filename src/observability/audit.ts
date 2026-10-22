import { z } from 'zod';
import type { RequestContext } from '../auth/context.js';
import type { TenantTransaction } from '../db/client.js';
import { auditLogs } from '../db/schema/security.js';

const auditSchema = z.object({
  action: z.string().min(1).max(100), entityType: z.string().min(1).max(100),
  entityId: z.uuid().nullish(), metadata: z.record(z.string(), z.json()).default({}),
}).strict();

// Reuse the action's transaction; never open or commit a separate audit transaction.
export async function writeAudit(tx: TenantTransaction, ctx: Pick<RequestContext, 'tenantId' | 'userId' | 'requestId'>, input: unknown): Promise<void> {
  const event = auditSchema.parse(input);
  await tx.insert(auditLogs).values({
    tenantId: z.uuid().parse(ctx.tenantId), actorUserId: z.uuid().parse(ctx.userId),
    requestId: z.uuid().parse(ctx.requestId), action: event.action, entityType: event.entityType,
    entityId: event.entityId ?? null, details: event.metadata,
  });
}
