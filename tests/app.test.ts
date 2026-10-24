import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { parseAuthConfig } from '../src/auth/config.js';
import type { HealthDeps } from '../src/health.js';

const applications: ReturnType<typeof buildApp>[] = [];
const authConfig = parseAuthConfig({ JWT_SECRET: randomBytes(32).toString('hex'), REFRESH_TOKEN_PEPPER: randomBytes(32).toString('hex') });

function createApp(level = 'silent', logs?: string[]) {
  const app = buildApp(
    parseConfig({ NODE_ENV: 'test', LOG_LEVEL: level }),
    logs === undefined ? undefined : { write: (line: string) => { logs.push(line); } },
    { authConfig },
  );
  applications.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe('GET /health', () => {
  it('returns the health contract', async () => {
    const response = await createApp().inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    const body: unknown = response.json();
    expect(z.object({ status: z.literal('ok') }).strict().parse(body)).toEqual({ status: 'ok' });
  });
});

describe('GET /health/live', () => {
  it('reports the process up with no dependency checks', async () => {
    const response = await createApp().inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /health/ready', () => {
  function createAppWithHealthDeps(healthDeps: HealthDeps) {
    const app = buildApp(parseConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), undefined, { authConfig, healthDeps });
    applications.push(app);
    return app;
  }

  it('returns 200 with no sensitive detail when every dependency is healthy', async () => {
    const response = await createAppWithHealthDeps({
      checkDatabase: () => Promise.resolve({ reachable: true, migrated: true }),
      checkChatModel: () => ({ ok: true }),
    }).inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: true, migrations: true, llmProvider: true } });
  });

  it('returns 503 with only boolean checks when the database is unreachable', async () => {
    const response = await createAppWithHealthDeps({
      checkDatabase: () => Promise.resolve({ reachable: false, migrated: false }),
      checkChatModel: () => ({ ok: true }),
    }).inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    // Only booleans, no raw error message/stack/connection detail from the failing dependency.
    expect(response.json()).toEqual({ status: 'error', checks: { database: false, migrations: false, llmProvider: true } });
  });

  it('returns 503 when migrations are not applied even though the database is reachable', async () => {
    const response = await createAppWithHealthDeps({
      checkDatabase: () => Promise.resolve({ reachable: true, migrated: false }),
      checkChatModel: () => ({ ok: true }),
    }).inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
  });

  it('returns 503 when the LLM provider is not configured', async () => {
    const response = await createAppWithHealthDeps({
      checkDatabase: () => Promise.resolve({ reachable: true, migrated: true }),
      checkChatModel: () => ({ ok: false }),
    }).inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
  });
});

describe('rate limiting', () => {
  it('returns 429 with a Retry-After header once the global limit is exceeded', async () => {
    const app = buildApp(
      parseConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' }),
      undefined, { authConfig },
    );
    applications.push(app);
    const remoteAddress = '203.0.113.42';
    await app.inject({ method: 'GET', url: '/health/live', remoteAddress });
    await app.inject({ method: 'GET', url: '/health/live', remoteAddress });
    const limited = await app.inject({ method: 'GET', url: '/health/live', remoteAddress });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('does not rate-limit a different client IP', async () => {
    const app = buildApp(
      parseConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW_MS: '60000' }),
      undefined, { authConfig },
    );
    applications.push(app);
    await app.inject({ method: 'GET', url: '/health/live', remoteAddress: '203.0.113.1' });
    const other = await app.inject({ method: 'GET', url: '/health/live', remoteAddress: '203.0.113.2' });
    expect(other.statusCode).toBe(200);
  });

  it('never skips the global limiter when NODE_ENV=production, even with the test-bypass flag set', async () => {
    const app = buildApp(
      parseConfig({ NODE_ENV: 'production', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW_MS: '60000', RATE_LIMIT_TEST_BYPASS: 'true' }),
      undefined, { authConfig },
    );
    applications.push(app);
    const remoteAddress = '203.0.113.99';
    await app.inject({ method: 'GET', url: '/health/live', remoteAddress });
    const limited = await app.inject({ method: 'GET', url: '/health/live', remoteAddress });
    expect(limited.statusCode).toBe(429);
  });
});

describe('request IDs and logging', () => {
  it('generates distinct UUIDs for concurrent requests', async () => {
    const app = createApp();
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/health' }),
      app.inject({ method: 'GET', url: '/health' }),
    ]);
    const ids = responses.map((response) => z.uuid().parse(response.headers['x-request-id']));
    expect(new Set(ids).size).toBe(2);
  });

  it('generates its own ID when a caller supplies an ID', async () => {
    const suppliedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const response = await createApp().inject({
      method: 'GET', url: '/health', headers: { 'x-request-id': suppliedId, 'request-id': suppliedId },
    });
    const id = z.uuid().parse(response.headers['x-request-id']);
    expect(id).not.toBe(suppliedId);
  });

  it('returns a request ID on unknown routes', async () => {
    const response = await createApp().inject({ method: 'GET', url: '/missing' });
    expect(response.statusCode).toBe(404);
    expect(z.uuid().safeParse(response.headers['x-request-id']).success).toBe(true);
  });

  it('uses the response ID in pino request and response logs', async () => {
    const logs: string[] = [];
    const response = await createApp('info', logs).inject({ method: 'GET', url: '/health' });
    const logSchema = z.object({ reqId: z.uuid(), msg: z.string(), level: z.number() });
    const entries = logs.map((line) => {
      const value: unknown = JSON.parse(line);
      return logSchema.parse(value);
    });
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ reqId: response.headers['x-request-id'], msg: 'incoming request', level: 30 }),
      expect.objectContaining({ reqId: response.headers['x-request-id'], msg: 'request completed', level: 30 }),
    ]));
  });
});
