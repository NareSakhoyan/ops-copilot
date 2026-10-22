import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { parseDatabaseConfig, parseMigrationConfig } from '../src/db/config.js';

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
