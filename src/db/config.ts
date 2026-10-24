import { z } from 'zod';
import { loadEnvironment } from '../config.js';
import { assertNotWeakInProduction, resolveSecret } from '../secrets.js';

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

// The password lives inside the connection URL, so a mounted Docker secret holds the whole URL
// (DATABASE_URL_FILE), not just the password segment.
function assertUrlPasswordNotWeak(name: string, url: string, nodeEnv: string): void {
  const password = decodeURIComponent(new URL(url).password);
  if (password) assertNotWeakInProduction(name, password, nodeEnv);
}

export function loadDatabaseConfig(environment: NodeJS.ProcessEnv = loadEnvironment()) {
  const databaseUrl = resolveSecret('DATABASE_URL', environment);
  const config = parseDatabaseConfig({ ...environment, ...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }) });
  assertUrlPasswordNotWeak('DATABASE_URL', config.DATABASE_URL, String(environment.NODE_ENV ?? 'development'));
  return config;
}

export function parseMigrationConfig(input: unknown) {
  return migrationConfigSchema.parse(input);
}

export function loadMigrationConfig(environment: NodeJS.ProcessEnv = loadEnvironment()) {
  const migrationUrl = resolveSecret('MIGRATION_DATABASE_URL', environment);
  const config = parseMigrationConfig({ ...environment, ...(migrationUrl === undefined ? {} : { MIGRATION_DATABASE_URL: migrationUrl }) });
  assertUrlPasswordNotWeak('MIGRATION_DATABASE_URL', config.MIGRATION_DATABASE_URL, String(environment.NODE_ENV ?? 'development'));
  return config;
}
