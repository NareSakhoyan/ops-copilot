import { pino } from 'pino';
import { loadConfig } from './config.js';
import { startTracing } from './observability/tracing.js';

async function main(): Promise<void> {
  const config = loadConfig();
  startTracing();
  // Catch environment-dependent schema initialization in the normal startup error path.
  const { buildApp } = await import('./app.js');
  const app = buildApp(config);

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error: unknown) {
    app.log.error({ err: error }, 'Server failed to start');
    await app.close();
    process.exitCode = 1;
    return;
  }

  // Fastify's close() stops accepting new connections and waits for in-flight requests before
  // running onClose hooks (DB pool, tracing). Force-exit if that hangs so a container's stop
  // grace period doesn't expire and send SIGKILL mid-cleanup.
  const SHUTDOWN_TIMEOUT_MS = 10000;
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    const timer = setTimeout(() => {
      app.log.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    try {
      await app.close();
    } catch (error: unknown) {
      app.log.error({ err: error }, 'Server failed to close');
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  };

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((error: unknown) => {
  pino().fatal({ err: error }, 'Application failed to initialize');
  process.exitCode = 1;
});
