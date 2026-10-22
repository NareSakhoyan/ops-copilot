import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { pino } from 'pino';
import type { DestinationStream } from 'pino';
import type { AppConfig } from './config.js';

export function buildApp(config: AppConfig, logStream?: DestinationStream) {
  const app = Fastify({
    loggerInstance: pino({ level: config.LOG_LEVEL }, logStream),
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('X-Request-ID', request.id);
    done();
  });

  app.get('/health', () => ({ status: 'ok' as const }));

  return app;
}
