import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
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
import { registerMcp } from './mcp/routes.js';
import type { answerFromKb } from './rag/answer.js';
import { registerHealth } from './health.js';
import type { HealthDeps } from './health.js';
import { fastifyOtelInstrumentation, shutdownTracing } from './observability/tracing.js';
import { registerMetricsRoute, httpRequestCounter, httpRequestDuration } from './observability/metrics.js';
import { redactValue } from './observability/redact.js';

export function buildApp(
  config: AppConfig,
  logStream?: DestinationStream,
  options: {
    authConfig?: AuthConfig; database?: TenantDatabase; mockBitrix?: MockBitrix;
    agentModel?: () => LanguageModel; agentKbAnswer?: typeof answerFromKb; healthDeps?: HealthDeps;
  } = {},
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
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.BODY_LIMIT_BYTES,
  });

  // Registered before any routes so @fastify/otel can wrap every subsequent route definition.
  app.register(fastifyOtelInstrumentation.plugin());

  app.register(helmet);
  const allowedOrigins = config.CORS_ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean);
  // No configured allowlist means no cross-origin access; this API has no browser frontend by default.
  app.register(cors, { origin: allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : false });

  // Global default; /auth/login, /auth/refresh, and /chat layer stricter per-route/per-user limits on top.
  // Never skip this in production: RATE_LIMIT_TEST_BYPASS only has effect outside NODE_ENV=production.
  const skipGlobalRateLimit = config.RATE_LIMIT_TEST_BYPASS && config.NODE_ENV !== 'production';
  if (!skipGlobalRateLimit) {
    // global:true's automatic per-route apply relies on an onRoute hook installed while the
    // plugin boots, which is deferred; buildApp is synchronous and declares routes immediately
    // afterward, so that boot would race every route declared below and silently rate-limit
    // nothing. Register with global:false and apply the default policy via our own hook instead,
    // resolving the `rateLimit` decorator lazily (it only exists once the plugin has booted,
    // guaranteed by the time the first real request arrives).
    app.register(rateLimit, { global: false, max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS });
    let defaultRateLimit: ReturnType<typeof app.rateLimit> | undefined;
    app.addHook('onRequest', async (request, reply) => {
      defaultRateLimit ??= app.rateLimit();
      await defaultRateLimit.call(app, request, reply);
    });
  }

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
  registerHealth(app, options.healthDeps);
  registerMetricsRoute(app);
  const db = options.database ?? database;
  const authConfig = options.authConfig ?? loadAuthConfig();
  registerAuth(app, db, authConfig);
  const mock = options.mockBitrix ?? createMockBitrix(db);
  registerMockBitrix(app, mock);
  const proposals = createApprovalsService(db, mock);
  registerApprovals(app, proposals);
  const agentDependencies = { ...(options.agentModel ? { model: options.agentModel } : {}), ...(options.agentKbAnswer ? { kbAnswer: options.agentKbAnswer } : {}) };
  registerChat(app, createAgentService({ database: db, proposals, ...agentDependencies }), {
    max: config.RATE_LIMIT_CHAT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS, skip: skipGlobalRateLimit,
  });
  const mcpAllowedOrigins = config.MCP_ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [];
  registerMcp(app, db, authConfig, proposals, {
    max: config.RATE_LIMIT_MCP_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS, skip: skipGlobalRateLimit,
  }, { allowedOrigins: mcpAllowedOrigins }, agentDependencies);

  app.addHook('onClose', closeDatabase);
  app.addHook('onClose', shutdownTracing);

  return app;
}
