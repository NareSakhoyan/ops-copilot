import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadAuthConfig, parseAuthConfig } from '../src/auth/config.js';

const secret = () => randomBytes(32).toString('hex');

describe('authentication configuration', () => {
  it('requires a signing secret and refresh-token pepper, and supplies issuer/audience defaults', () => {
    const jwtSecret = secret();
    const pepper = secret();
    expect(parseAuthConfig({ JWT_SECRET: jwtSecret, REFRESH_TOKEN_PEPPER: pepper, OTHER: 'ignored' }))
      .toEqual({ JWT_SECRET: jwtSecret, REFRESH_TOKEN_PEPPER: pepper, JWT_ISSUER: 'ops-copilot', JWT_AUDIENCE: 'ops-copilot-api' });
  });

  it.each([
    {}, { JWT_SECRET: '' }, { JWT_SECRET: 'short' }, { JWT_SECRET: 'x'.repeat(513) },
    { JWT_SECRET: 'x'.repeat(32) }, { JWT_SECRET: 'x'.repeat(32), REFRESH_TOKEN_PEPPER: 'short' },
    { JWT_SECRET: 'x'.repeat(32), REFRESH_TOKEN_PEPPER: 'y'.repeat(32), JWT_ISSUER: '' },
    { JWT_SECRET: 'x'.repeat(32), REFRESH_TOKEN_PEPPER: 'y'.repeat(32), JWT_AUDIENCE: '' },
  ])('rejects invalid settings: %j', (input) => {
    expect(() => parseAuthConfig(input)).toThrow(z.ZodError);
  });
});

describe('loadAuthConfig', () => {
  it('resolves JWT_SECRET and REFRESH_TOKEN_PEPPER from _FILE paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auth-config-test-'));
    const jwtPath = join(dir, 'jwt_secret');
    const pepperPath = join(dir, 'refresh_pepper');
    writeFileSync(jwtPath, secret());
    writeFileSync(pepperPath, secret());
    const config = loadAuthConfig({ JWT_SECRET_FILE: jwtPath, REFRESH_TOKEN_PEPPER_FILE: pepperPath });
    expect(config.JWT_SECRET).toHaveLength(64);
    expect(config.REFRESH_TOKEN_PEPPER).toHaveLength(64);
  });

  it('prefers the _FILE value over a plain variable when both are set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auth-config-test-'));
    const jwtPath = join(dir, 'jwt_secret');
    const fileSecret = secret();
    writeFileSync(jwtPath, fileSecret);
    const config = loadAuthConfig({ JWT_SECRET: secret(), JWT_SECRET_FILE: jwtPath, REFRESH_TOKEN_PEPPER: secret() });
    expect(config.JWT_SECRET).toBe(fileSecret);
  });

  it('still rejects a too-short secret resolved from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auth-config-test-'));
    const jwtPath = join(dir, 'jwt_secret');
    writeFileSync(jwtPath, 'too-short');
    expect(() => loadAuthConfig({ JWT_SECRET_FILE: jwtPath, REFRESH_TOKEN_PEPPER: secret() })).toThrow(z.ZodError);
  });
});
