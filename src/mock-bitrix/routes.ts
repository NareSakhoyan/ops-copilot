import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { tasks } from '../db/schema/crm.js';
import type { MockBitrix } from './service.js';

const taskFieldsSchema = z.object({ fields: z.object({
  TITLE: z.string(), DESCRIPTION: z.string(), RESPONSIBLE_ID: z.uuid(), DEADLINE: z.string(),
}).strict() }).strict();
const taskIdSchema = z.object({ taskId: z.uuid() }).strict();

function taskView(task: typeof tasks.$inferSelect) {
  return { result: { task: { id: task.id, title: task.title ?? task.description, description: task.description,
    responsibleId: task.assigneeEmployeeId, deadline: task.dueAt.toISOString(), status: task.status } } };
}

export function registerMockBitrix(app: FastifyInstance, mock: MockBitrix): void {
  app.post('/rest/crm.deal.list', { preHandler: app.authenticate }, async (request) => ({ result: await mock.listDeals(request.context, request.body ?? {}) }));
  app.post('/rest/crm.contact.list', { preHandler: app.authenticate }, async (request) => ({ result: await mock.listContacts(request.context, request.body ?? {}) }));
  app.post('/rest/tasks.task.get', { preHandler: app.authenticate }, async (request) => taskView(await mock.getTask(request.context, taskIdSchema.parse(request.body).taskId)));
  app.post('/rest/tasks.task.add', { preHandler: app.authenticate }, async (request) => {
    const key = z.uuid().parse(request.headers['idempotency-key']);
    const { fields } = taskFieldsSchema.parse(request.body);
    return taskView(await mock.addTask(request.context, key, { title: fields.TITLE, description: fields.DESCRIPTION, assigneeEmployeeId: fields.RESPONSIBLE_ID, dueAt: fields.DEADLINE }));
  });
}
