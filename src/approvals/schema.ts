import { z } from 'zod';

export const taskPayloadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  assigneeEmployeeId: z.uuid(),
  dueAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
}).strict();

export const proposalSchema = z.object({ type: z.literal('task.create'), payload: taskPayloadSchema }).strict();
export const approvalListSchema = z.object({
  status: z.enum(['pending', 'approved', 'executing', 'executed', 'failed', 'rejected', 'expired']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
export type TaskPayload = z.infer<typeof taskPayloadSchema>;
