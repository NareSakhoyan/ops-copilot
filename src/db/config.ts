import { z } from 'zod';
import { loadEnvironment } from '../config.js';

const postgresUrl = z.url({ protocol: /^postgres(?:ql)?$/ });
const migrationConfigSchema = z.object({
  MIGRATION_DATABASE_URL: postgresUrl,
});

const databaseConfigSchema = z.object({
  DATABASE_URL: postgresUrl.pipe(z.string().refine((url) => {
    const parsed = new URL(url);
    return parsed.username === 'app_user' && !parsed.searchParams.has('user');
  }, { message: 'DATABASE_URL must connect as app_user without a query-string user override' })),
});

export function parseDatabaseConfig(input: unknown) {
  return databaseConfigSchema.parse(input);
}

export function loadDatabaseConfig() {
  return parseDatabaseConfig(loadEnvironment());
}

export function parseMigrationConfig(input: unknown) {
  return migrationConfigSchema.parse(input);
}

export function loadMigrationConfig() {
  return parseMigrationConfig(loadEnvironment());
}
