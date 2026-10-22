import { pino } from 'pino';
import { loadConfig } from '../../config.js';
import { createDbClient } from '../client.js';
import { loadDatabaseConfig } from '../config.js';
import { seedDatabase } from './index.js';

const logger = pino();

async function main(): Promise<void> {
  if (loadConfig().NODE_ENV === 'production') {
    logger.fatal('Development seed cannot run with NODE_ENV=production');
    process.exitCode = 1;
    return;
  }
  const client = createDbClient(loadDatabaseConfig().DATABASE_URL);
  try {
    for (const result of await seedDatabase(client)) logger.info(result, 'Development seed');
  } finally {
    await client.close();
  }
}

main().catch(() => {
  logger.fatal('Development seed failed; verify migrations and app_user database access');
  process.exitCode = 1;
});
