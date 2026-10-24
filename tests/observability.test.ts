import { randomUUID } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { loadContext } from '../src/auth/context.js';
import { createDbClient } from '../src/db/client.js';
import { demoTenants } from '../src/db/seed/data.js';
import { seedDatabase } from '../src/db/seed/index.js';
import { users } from '../src/db/schema/identity.js';
import { createApprovalsService } from '../src/approvals/service.js';
import { createMockBitrix } from '../src/mock-bitrix/service.js';
import { createAgentService } from '../src/agent/service.js';
import { withToolSpan, withAgentRunSpan, recordAgentStep } from '../src/observability/spans.js';
import { redactValue } from '../src/observability/redact.js';
import { runMigrations, startTestDatabase } from './helpers/database.js';
import { MockLanguageModelV4, modelText, modelTool } from './helpers/model.js';

// Registered exactly once for this whole file: @opentelemetry/api's global tracer provider
// can only be set once per process (a second setGlobalTracerProvider call is a silent no-op,
// and trace.disable() does not undo that - it permanently breaks the proxy's delegation).
// Each test reads this one exporter and resets it afterward instead of re-registering.
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);
// Production gets this for free from NodeSDK's own default; it must be set up explicitly here
// so active-span context (parent/child linkage) survives the awaits between nested spans.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

describe('span redaction and exception recording (no database)', () => {
  afterEach(() => exporter.reset());

  it('redacts emails, phone numbers, token-shaped strings, and sensitive key names', () => {
    const input = { email: 'rep@example.invalid', phone: '+1 555-123-4567', note: 'call +37410123456 about it',
      accessToken: 'super-secret-value', nested: { password: 'p@ss', apiKey: 'abcdefghijklmnopqrstuvwxyz012345' } };
    const result = redactValue(input) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain('rep@example.invalid');
    expect(JSON.stringify(result)).not.toContain('555-123-4567');
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
    expect(result.accessToken).toBe('[redacted]');
    expect((result.nested as Record<string, unknown>).password).toBe('[redacted]');
    expect((result.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
  });

  it('redacts a sensitive tool input before it reaches the tool.call span attribute', async () => {
    await withToolSpan('crm_search', { query: 'contact me at leak@example.invalid', accessToken: 'leaked-secret-token-value' }, () => Promise.resolve({ rows: [] }));
    const span = exporter.getFinishedSpans().find((candidate) => candidate.name === 'tool.call');
    expect(span).toBeDefined();
    const recordedInput = String(span?.attributes['tool.input']);
    expect(recordedInput).not.toContain('leak@example.invalid');
    expect(recordedInput).not.toContain('leaked-secret-token-value');
  });

  it('records a thrown tool error as a span exception with ERROR status', async () => {
    await expect(withToolSpan('crm_search', {}, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const span = exporter.getFinishedSpans().find((candidate) => candidate.name === 'tool.call');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.some((event) => event.name === 'exception')).toBe(true);
  });

  it('records an agent.run exception and keeps agent.step as its child span', async () => {
    await expect(withAgentRunSpan(() => {
      recordAgentStep({ 'agent.step.index': 0 });
      return Promise.reject(new Error('agent failed'));
    })).rejects.toThrow('agent failed');
    const spans = exporter.getFinishedSpans();
    const run = spans.find((candidate) => candidate.name === 'agent.run');
    const step = spans.find((candidate) => candidate.name === 'agent.step');
    expect(run?.status.code).toBe(SpanStatusCode.ERROR);
    expect(step?.spanContext().traceId).toBe(run?.spanContext().traceId);
    expect(step?.parentSpanContext?.spanId).toBe(run?.spanContext().spanId);
  });
});

describe('end-to-end chat trace (real database, mocked model)', () => {
  const tenant = demoTenants[0];
  let container: StartedPostgreSqlContainer;
  let ownerPool: Pool;
  let client: ReturnType<typeof createDbClient>;
  let proposals: ReturnType<typeof createApprovalsService>;

  beforeAll(async () => {
    container = await startTestDatabase('observability_test');
    ownerPool = new Pool({ connectionString: container.getConnectionUri() });
    runMigrations(container);
    await drizzle(ownerPool).execute(sql`ALTER ROLE app_user PASSWORD 'observability-test-only-password'`);
    const url = new URL(container.getConnectionUri()); url.username = 'app_user'; url.password = 'observability-test-only-password';
    client = createDbClient(url.toString());
    await seedDatabase(client);
    proposals = createApprovalsService(client, createMockBitrix(client));
  }, 180000);
  afterAll(async () => {
    await client?.close(); await ownerPool?.end();
    if (container) await container.stop();
  }, 30000);
  afterEach(() => exporter.reset());

  it('produces one trace linking the agent run, its step, the sql_analytics tool call, and the nested LLM calls', async () => {
    const ctx = await client.withTenant({ tenant_id: tenant.id, user_id: tenant.adminId }, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.email, 'admin@example.invalid'));
      if (!user) throw new Error('Missing seed fixture');
      const loaded = await loadContext(tx, tenant.id, user.id, randomUUID());
      if (!loaded) throw new Error('Missing agent context');
      return loaded;
    });
    const model = new MockLanguageModelV4({ doGenerate: [
      modelTool('sql_analytics', { question: 'How many deals?' }),
      modelText('SELECT count(*) AS total FROM v_deals'),
      modelText('There are 600 deals.'),
    ] });
    const result = await createAgentService({ database: client, proposals, model: () => model }).chat(ctx, { message: 'How many deals?' });
    expect(result.answer).toContain('600');

    const spans = exporter.getFinishedSpans();
    const byName = (name: string) => spans.filter((span) => span.name === name);
    const run = byName('agent.run')[0];
    const toolCall = byName('tool.call').find((span) => span.attributes['tool.name'] === 'sql_analytics');
    const llmCalls = byName('llm.call');
    const guardVerdict = byName('sql_guard.verdict')[0];
    expect(run).toBeDefined();
    expect(toolCall).toBeDefined();
    expect(llmCalls.length).toBeGreaterThanOrEqual(2); // agent.plan + sql.generate
    expect(guardVerdict).toBeDefined();
    // Every span in this chat call belongs to the same trace.
    const traceId = run?.spanContext().traceId;
    for (const span of [toolCall, guardVerdict, ...llmCalls]) expect(span?.spanContext().traceId).toBe(traceId);
    expect(toolCall?.attributes['tool.status']).toBe('succeeded');
    const sqlGenerateCall = llmCalls.find((span) => span.attributes['llm.function_id'] === 'sql.generate');
    expect(sqlGenerateCall?.parentSpanContext?.spanId).toBe(toolCall?.spanContext().spanId);
  }, 30000);
});
