import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { createAgentService } from './service.js';

export interface ChatRateLimitOptions {
  max: number;
  timeWindow: number;
  /** Only ever true outside NODE_ENV=production; see src/app.ts. */
  skip?: boolean;
}

export function registerChat(
  app: FastifyInstance, agent: ReturnType<typeof createAgentService>, rateLimitOptions: ChatRateLimitOptions,
): void {
  app.register(async (routes) => {
    if (!rateLimitOptions.skip) {
      // Registered before the auth preHandler hook below so its own preHandler-stage check runs
      // after authentication (per @fastify/rate-limit's documented "custom hook" pattern), letting
      // keyGenerator key on the authenticated user ID instead of falling back to the shared IP.
      await routes.register(rateLimit, {
        global: false, hook: 'preHandler', max: rateLimitOptions.max, timeWindow: rateLimitOptions.timeWindow,
        keyGenerator: (request) => request.context?.userId ?? request.ip,
      });
    }
    routes.addHook('preHandler', routes.authenticate);
    routes.post('/chat', rateLimitOptions.skip ? {} : {
      config: { rateLimit: { max: rateLimitOptions.max, timeWindow: rateLimitOptions.timeWindow } },
    }, (request) => agent.chat(request.context, request.body));
  });
}
