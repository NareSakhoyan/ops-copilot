import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNotWeakInProduction, isWeakSecretValue, resolveSecret, resolveSecrets } from '../src/secrets.js';

const dirs: string[] = [];
function secretFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-test-'));
  dirs.push(dir);
  const path = join(dir, 'secret');
  writeFileSync(path, contents);
  return path;
}

afterEach(() => { dirs.length = 0; });

describe('resolveSecret', () => {
  it('reads the plain variable when no _FILE variant is set', () => {
    expect(resolveSecret('JWT_SECRET', { JWT_SECRET: 'plain-value' })).toBe('plain-value');
  });

  it('reads and trims the file when only _FILE is set', () => {
    const path = secretFile('from-file-value\n');
    expect(resolveSecret('JWT_SECRET', { JWT_SECRET_FILE: path })).toBe('from-file-value');
  });

  it('prefers _FILE over the plain variable when both are set', () => {
    const path = secretFile('file-wins');
    expect(resolveSecret('JWT_SECRET', { JWT_SECRET: 'plain-loses', JWT_SECRET_FILE: path })).toBe('file-wins');
  });

  it('returns undefined when neither is set', () => {
    expect(resolveSecret('JWT_SECRET', {})).toBeUndefined();
  });

  it('fails fast when _FILE points at a missing path', () => {
    expect(() => resolveSecret('JWT_SECRET', { JWT_SECRET_FILE: '/nonexistent/path/secret' })).toThrow(/JWT_SECRET_FILE/);
  });
});

describe('resolveSecrets', () => {
  it('resolves each named secret independently and leaves other variables untouched', () => {
    const path = secretFile('pepper-value');
    const result = resolveSecrets(
      { JWT_SECRET: 'inline', REFRESH_TOKEN_PEPPER_FILE: path, OTHER: 'kept' },
      ['JWT_SECRET', 'REFRESH_TOKEN_PEPPER'],
    );
    expect(result).toMatchObject({ JWT_SECRET: 'inline', REFRESH_TOKEN_PEPPER: 'pepper-value', OTHER: 'kept' });
  });

  it('removes the key entirely when a secret is absent from both forms', () => {
    const result = resolveSecrets({ OTHER: 'kept' }, ['JWT_SECRET']);
    expect(result).not.toHaveProperty('JWT_SECRET');
    expect(result.OTHER).toBe('kept');
  });
});

describe('isWeakSecretValue', () => {
  it.each(['password', 'Password', 'local-development-only', 'changeme', '123456'])(
    'flags known placeholder value: %s', (value) => {
      expect(isWeakSecretValue(value)).toBe(true);
    },
  );

  it('does not flag a high-entropy value', () => {
    expect(isWeakSecretValue('f3a9c1e7b2d4a6c8e0f1a3b5c7d9e1f3')).toBe(false);
  });
});

describe('assertNotWeakInProduction', () => {
  it('throws for a weak value when NODE_ENV is production', () => {
    expect(() => assertNotWeakInProduction('JWT_SECRET', 'changeme', 'production')).toThrow(/JWT_SECRET/);
  });

  it('does not throw for a weak value outside production', () => {
    expect(() => assertNotWeakInProduction('JWT_SECRET', 'changeme', 'development')).not.toThrow();
    expect(() => assertNotWeakInProduction('JWT_SECRET', 'changeme', 'test')).not.toThrow();
  });

  it('does not throw for a strong value in production', () => {
    expect(() => assertNotWeakInProduction('JWT_SECRET', 'f3a9c1e7b2d4a6c8e0f1a3b5c7d9e1f3', 'production')).not.toThrow();
  });
});
