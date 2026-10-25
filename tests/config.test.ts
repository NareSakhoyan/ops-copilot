import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { loadConfig, parseConfig } from '../src/config.js';

const temporaryDirectories: string[] = [];

function createEnvPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ops-copilot-config-'));
  temporaryDirectories.push(directory);
  return join(directory, '.env');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('environment validation', () => {
  it('provides the approved defaults', () => {
    expect(parseConfig({})).toEqual({
      NODE_ENV: 'development', HOST: '127.0.0.1', PORT: 3000, LOG_LEVEL: 'info',
      TRUST_PROXY: false, BODY_LIMIT_BYTES: 1048576, CORS_ALLOWED_ORIGINS: undefined,
      RATE_LIMIT_MAX: 300, RATE_LIMIT_WINDOW_MS: 60000, RATE_LIMIT_CHAT_MAX: 30, RATE_LIMIT_MCP_MAX: 30,
      RATE_LIMIT_TEST_BYPASS: false, MCP_ALLOWED_ORIGINS: undefined,
    });
  });

  it.each([
    [undefined, false], ['true', true], ['false', false], ['203.0.113.5', '203.0.113.5'],
  ])('parses TRUST_PROXY %j as %j', (input, expected) => {
    expect(parseConfig(input === undefined ? {} : { TRUST_PROXY: input }).TRUST_PROXY).toBe(expected);
  });

  it.each([
    { PORT: '' }, { PORT: 'abc' }, { PORT: '0' }, { PORT: '65536' }, { PORT: '1.5' },
    { NODE_ENV: 'staging' }, { LOG_LEVEL: 'verbose' }, { HOST: '   ' },
  ])('rejects invalid settings: %j', (environment) => {
    expect(() => parseConfig(environment)).toThrow(ZodError);
  });
});

describe('required .env file', () => {
  it('loads settings from a real file', () => {
    const path = createEnvPath();
    writeFileSync(path, 'NODE_ENV=test\nPORT=8081\nLOG_LEVEL=debug\n');
    expect(loadConfig(path, {})).toMatchObject({ NODE_ENV: 'test', PORT: 8081, LOG_LEVEL: 'debug' });
  });

  it('allows process environment to override file settings', () => {
    const path = createEnvPath();
    writeFileSync(path, 'PORT=8081\nLOG_LEVEL=info\n');
    expect(loadConfig(path, { PORT: '9090', LOG_LEVEL: 'error' }))
      .toMatchObject({ PORT: 9090, LOG_LEVEL: 'error' });
  });

  it('fails without the file even when environment variables are provided', () => {
    expect(() => loadConfig(createEnvPath(), {
      NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3000', LOG_LEVEL: 'info',
    })).toThrow(/ENOENT/);
  });

  it('ships a valid .env.example with the approved defaults', () => {
    expect(loadConfig(resolve('.env.example'), {})).toEqual(parseConfig({}));
  });
});
