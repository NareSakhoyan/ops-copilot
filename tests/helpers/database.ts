import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { expect } from 'vitest';

export function startTestDatabase(databaseName: string) {
  return new PostgreSqlContainer('pgvector/pgvector:pg18')
    .withUsername('migration_owner')
    .withDatabase(databaseName)
    .withPassword(randomBytes(24).toString('hex'))
    .withCopyFilesToContainer([{
      source: fileURLToPath(new URL('../../docker/init.sql', import.meta.url)),
      target: '/docker-entrypoint-initdb.d/001-init.sql',
    }])
    .start();
}

export function runMigrations(container: StartedPostgreSqlContainer): void {
  const result = spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../../src/db/migrate.ts', import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, MIGRATION_DATABASE_URL: container.getConnectionUri() },
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
