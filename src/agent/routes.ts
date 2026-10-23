import type { FastifyInstance } from 'fastify';
import type { createAgentService } from './service.js';

export function registerChat(app: FastifyInstance, agent: ReturnType<typeof createAgentService>): void {
  app.post('/chat', { preHandler: app.authenticate }, (request) => agent.chat(request.context, request.body));
}
