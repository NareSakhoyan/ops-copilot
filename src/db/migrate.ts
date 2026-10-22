import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { pino } from 'pino';
import { loadMigrationConfig } from './config.js';
import { grants } from './grants.js';

async function main(): Promise<void> {
  const config = loadMigrationConfig();
  const pool = new Pool({ connectionString: config.MIGRATION_DATABASE_URL });

  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
    await db.execute(grants);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  pino().fatal({ err: error }, 'Database migration failed');
  process.exitCode = 1;
});
