import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { createApprovalsService } from './service.js';

const paramsSchema = z.object({ id: z.uuid() }).strict();
const emptyBodySchema = z.object({}).strict();

export function registerApprovals(app: FastifyInstance, service: ReturnType<typeof createApprovalsService>): void {
  app.get('/approvals', { preHandler: app.authenticate }, (request) => service.list(request.context, request.query));
  app.post('/approvals/:id/approve', { preHandler: app.authenticate }, (request) => {
    emptyBodySchema.parse(request.body ?? {});
    return service.approve(request.context, paramsSchema.parse(request.params).id);
  });
  app.post('/approvals/:id/reject', { preHandler: app.authenticate }, (request) => {
    emptyBodySchema.parse(request.body ?? {});
    return service.reject(request.context, paramsSchema.parse(request.params).id);
  });
}
