import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { loadDatabaseConfig, loadMigrationConfig, parseDatabaseConfig, parseMigrationConfig } from '../src/db/config.js';

describe('migration configuration', () => {
  it.each([undefined, '', 'not-a-url', 'https://localhost/db', 'mysql://localhost/db'])(
    'rejects an absent or invalid migration URL: %s', (url) => {
      expect(() => parseMigrationConfig({ MIGRATION_DATABASE_URL: url })).toThrow(ZodError);
    },
  );

  it('requires the owner URL even when an application URL is present', () => {
    expect(() => parseMigrationConfig({ DATABASE_URL: 'postgresql://app_user:password@localhost/db' }))
      .toThrow(ZodError);
  });
});

describe('application database configuration', () => {
  it.each([undefined, '', 'not-a-url', 'https://localhost/db',
    'postgresql://migration_owner:password@localhost/db', 'postgresql://postgres:password@localhost/db',
    'postgresql://localhost/db',
    'postgresql://app_user:password@localhost/db?user=migration_owner',
    'postgresql://app_user:password@localhost/db?user=app_user&user=migration_owner'])(
    'rejects missing, malformed, or non-app_user credentials: %s', (url) => {
      expect(() => parseDatabaseConfig({ DATABASE_URL: url })).toThrow(ZodError);
    },
  );

  it('never falls back to owner credentials', () => {
    expect(() => parseDatabaseConfig({ MIGRATION_DATABASE_URL: 'postgresql://migration_owner:password@localhost/db' }))
      .toThrow(ZodError);
  });
});

describe('loadDatabaseConfig / loadMigrationConfig secrets', () => {
  function urlFile(url: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'db-config-test-'));
    const path = join(dir, 'url');
    writeFileSync(path, url);
    return path;
  }

  it('resolves DATABASE_URL from a _FILE path', () => {
    const path = urlFile('postgresql://app_user:s3cure-generated-value@localhost/db');
    expect(loadDatabaseConfig({ DATABASE_URL_FILE: path }).DATABASE_URL).toBe('postgresql://app_user:s3cure-generated-value@localhost/db');
  });

  it('resolves MIGRATION_DATABASE_URL from a _FILE path', () => {
    const path = urlFile('postgresql://migration_owner:s3cure-generated-value@localhost/db');
    expect(loadMigrationConfig({ MIGRATION_DATABASE_URL_FILE: path }).MIGRATION_DATABASE_URL)
      .toBe('postgresql://migration_owner:s3cure-generated-value@localhost/db');
  });

  it('rejects a known development placeholder password in production', () => {
    expect(() => loadDatabaseConfig({
      NODE_ENV: 'production', DATABASE_URL: 'postgresql://app_user:local-app-development-only@localhost/db',
    })).toThrow(/DATABASE_URL/);
  });

  it('allows the same placeholder password outside production', () => {
    expect(() => loadDatabaseConfig({
      NODE_ENV: 'development', DATABASE_URL: 'postgresql://app_user:local-app-development-only@localhost/db',
    })).not.toThrow();
  });

  it('allows a non-placeholder password in production', () => {
    expect(() => loadDatabaseConfig({
      NODE_ENV: 'production', DATABASE_URL: 'postgresql://app_user:f3a9c1e7b2d4a6c8@localhost/db',
    })).not.toThrow();
  });
});
