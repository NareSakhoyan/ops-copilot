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
import { createApprovalsService } from './approvals/service.js';
import { registerApprovals } from './approvals/routes.js';
import { createMockBitrix } from './mock-bitrix/service.js';
import type { MockBitrix } from './mock-bitrix/service.js';
import { registerMockBitrix } from './mock-bitrix/routes.js';
import type { LanguageModel } from 'ai';
import { createAgentService } from './agent/service.js';
import { registerChat } from './agent/routes.js';
import { fastifyOtelInstrumentation, shutdownTracing } from './observability/tracing.js';
import { registerMetricsRoute, httpRequestCounter, httpRequestDuration } from './observability/metrics.js';
import { redactValue } from './observability/redact.js';

export function buildApp(
  config: AppConfig,
  logStream?: DestinationStream,
  options: { authConfig?: AuthConfig; database?: TenantDatabase; mockBitrix?: MockBitrix; agentModel?: () => LanguageModel } = {},
) {
  const logger: FastifyBaseLogger = pino({
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'refreshToken', 'accessToken'],
    // Path-based redact above only catches known fields; this backstops free-text emails/phones/tokens in any logged payload.
    formatters: { log: (object) => redactValue(object) as Record<string, unknown> },
  }, logStream);
  const app = Fastify({
    loggerInstance: logger,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  // Registered before any routes so @fastify/otel can wrap every subsequent route definition.
  app.register(fastifyOtelInstrumentation.plugin());

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('X-Request-ID', request.id);
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? request.url;
    httpRequestCounter.add(1, { route, method: request.method, status: reply.statusCode });
    httpRequestDuration.record(reply.elapsedTime, { route });
    done();
  });

  app.get('/health', () => ({ status: 'ok' as const }));
  registerMetricsRoute(app);
  const db = options.database ?? database;
  registerAuth(app, db, options.authConfig ?? loadAuthConfig());
  const mock = options.mockBitrix ?? createMockBitrix(db);
  registerMockBitrix(app, mock);
  const proposals = createApprovalsService(db, mock);
  registerApprovals(app, proposals);
  registerChat(app, createAgentService({ database: db, proposals, ...(options.agentModel ? { model: options.agentModel } : {}) }));

  app.addHook('onClose', closeDatabase);
  app.addHook('onClose', shutdownTracing);

  return app;
}
