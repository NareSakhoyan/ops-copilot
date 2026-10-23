import { pino } from 'pino';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
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

  const shutdown = async (): Promise<void> => {
    try {
      await app.close();
    } catch (error: unknown) {
      app.log.error({ err: error }, 'Server failed to close');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

main().catch((error: unknown) => {
  pino().fatal({ err: error }, 'Application failed to initialize');
  process.exitCode = 1;
});
