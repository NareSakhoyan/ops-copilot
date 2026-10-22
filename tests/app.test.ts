import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';

const applications: ReturnType<typeof buildApp>[] = [];

function createApp(level = 'silent', logs?: string[]) {
  const app = buildApp(
    parseConfig({ NODE_ENV: 'test', LOG_LEVEL: level }),
    logs === undefined ? undefined : { write: (line: string) => { logs.push(line); } },
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
