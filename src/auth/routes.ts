import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import type { TenantDatabase } from '../db/client.js';
import { auditLogs } from '../db/schema/security.js';
import type { AuthConfig } from './config.js';
import { loadContext } from './context.js';
import type { RequestContext } from './context.js';
import { can, recordScope } from './rbac.js';
import { AuthenticationError, createAuthService } from './service.js';
import { verifyAccessToken } from './tokens.js';
import { HttpError } from '../routes/errors.js';

declare module 'fastify' {
  interface FastifyRequest { context: RequestContext }
  interface FastifyInstance { authenticate: preHandlerAsyncHookHandler }
}

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();

export function registerAuth(app: FastifyInstance, database: TenantDatabase, config: AuthConfig): void {
  const auth = createAuthService(database, config);
  app.decorateRequest('context');
  app.decorate('authenticate', async (request, reply) => {
    const authorization = z.string().max(8192).regex(/^Bearer \S+$/).safeParse(request.headers.authorization);
    if (!authorization.success) return reply.code(401).send({ error: 'Unauthorized' });
    let claims;
    try { claims = await verifyAccessToken(config, authorization.data.slice(7)); }
    catch { return reply.code(401).send({ error: 'Unauthorized' }); }
    const ctx = await database.withTenant({ tenant_id: claims.tenantId, user_id: claims.userId }, (tx) =>
      loadContext(tx, claims.tenantId, claims.userId, request.id));
    if (!ctx) return reply.code(401).send({ error: 'Unauthorized' });
    request.context = ctx;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request' });
    if (error instanceof AuthenticationError) return reply.code(401).send({ error: error.message });
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
    const clientError = z.object({ statusCode: z.number().int().min(400).max(499) }).safeParse(error);
    if (clientError.success) {
      const status = clientError.data.statusCode;
      return reply.code(status).send({ error: status === 429 ? 'Too many requests' : 'Invalid request' });
    }
    // SQL/driver errors can contain query parameters; do not log their raw values.
    request.log.error({ errorName: error instanceof Error ? error.name : 'Unknown' }, 'Request failed');
    return reply.code(500).send({ error: 'Internal server error' });
  });

  // Encapsulate the limiter to the auth routes; the decorated preHandler is shared.
  app.register(async (routes) => {
    await routes.register(rateLimit, { global: false });
    routes.post('/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return auth.login(request.body, request.id);
    });
    routes.post('/auth/refresh', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return auth.refresh(request.body, request.id);
    });
    routes.post('/auth/logout', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      await auth.logout(request.body, request.id);
      return reply.code(204).send();
    });
  });

  app.get('/audit-logs', { preHandler: app.authenticate }, async (request, reply) => {
    if (!can(request.context, 'audit_logs:read') || recordScope(request.context, 'rows').kind !== 'tenant') {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { limit, offset } = paginationSchema.parse(request.query);
    const ctx = request.context;
    return database.withTenant({ tenant_id: ctx.tenantId, user_id: ctx.userId }, (tx) =>
      tx.select().from(auditLogs).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(limit).offset(offset));
  });
}
