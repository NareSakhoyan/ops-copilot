import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import { pino } from 'pino';
import type { DestinationStream } from 'pino';
import type { AppConfig } from './config.js';
import { closeDatabase, database } from './db/client.js';
import type { TenantDatabase } from './db/client.js';
import { loadAuthConfig } from './auth/config.js';
import type { AuthConfig } from './auth/config.js';
import { registerAuth } from './auth/routes.js';

export function buildApp(
  config: AppConfig,
  logStream?: DestinationStream,
  options: { authConfig?: AuthConfig; database?: TenantDatabase } = {},
) {
  const logger: FastifyBaseLogger = pino({
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'refreshToken', 'accessToken'],
  }, logStream);
  const app = Fastify({
    loggerInstance: logger,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('X-Request-ID', request.id);
    done();
  });

  app.get('/health', () => ({ status: 'ok' as const }));
  registerAuth(app, options.database ?? database, options.authConfig ?? loadAuthConfig());

  app.addHook('onClose', closeDatabase);

  return app;
}
