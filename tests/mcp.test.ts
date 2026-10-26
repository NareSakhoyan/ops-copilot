import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { parseAuthConfig } from '../src/auth/config.js';
import { loadContext } from '../src/auth/context.js';
import { signAccessToken } from '../src/auth/tokens.js';
import { createDbClient } from '../src/db/client.js';
import { demoTenants } from '../src/db/seed/data.js';
import { seedDatabase } from '../src/db/seed/index.js';
import { deals, tasks } from '../src/db/schema/crm.js';
import { pendingActions } from '../src/db/schema/approvals.js';
import { sqlExecutionLog } from '../src/db/schema/analytics-log.js';
import { auditLogs } from '../src/db/schema/security.js';
import { users } from '../src/db/schema/identity.js';
import { createCrmSearchTool } from '../src/agent/tools.js';
import { FakeEmbedder } from '../src/rag/embed.js';
import { createIngestor } from '../src/rag/ingest.js';
import { createKbAnswerer } from '../src/rag/answer.js';
import { runMigrations, startTestDatabase } from './helpers/database.js';
import { MockLanguageModelV4, modelText } from './helpers/model.js';

const tenant = demoTenants[0];
const other = demoTenants[1];
const authConfig = parseAuthConfig({ JWT_SECRET: randomBytes(32).toString('hex'), REFRESH_TOKEN_PEPPER: randomBytes(32).toString('hex') });
const invocation = { toolCallId: 'test', messages: [], context: {} };
let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let client: ReturnType<typeof createDbClient>;
const applications: ReturnType<typeof buildApp>[] = [];

function trackApp(app: ReturnType<typeof buildApp>): ReturnType<typeof buildApp> {
  applications.push(app);
  return app;
}

async function context(email = 'admin@example.invalid', tenantId: string = tenant.id) {
  return client.withTenant({ tenant_id: tenantId, user_id: tenant.adminId }, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.email, email));
    if (!user) throw new Error('Missing MCP fixture user');
    const ctx = await loadContext(tx, tenantId, user.id, randomUUID());
    if (!ctx) throw new Error('Missing MCP fixture context');
    return ctx;
  });
}
async function tokenFor(email = 'admin@example.invalid', tenantId: string = tenant.id): Promise<string> {
  const ctx = await context(email, tenantId);
  return signAccessToken(authConfig, { tenantId: ctx.tenantId, userId: ctx.userId, roles: ctx.roles });
}

beforeAll(async () => {
  container = await startTestDatabase('mcp_test');
  ownerPool = new Pool({ connectionString: container.getConnectionUri() });
  runMigrations(container);
  await drizzle(ownerPool).execute(sql`ALTER ROLE app_user PASSWORD 'mcp-test-only-password'`);
  const url = new URL(container.getConnectionUri()); url.username = 'app_user'; url.password = 'mcp-test-only-password';
  client = createDbClient(url.toString());
  await seedDatabase(client);
}, 180000);

afterAll(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
  await client?.close(); await ownerPool?.end();
  if (container) await container.stop();
}, 30000);

function rpc(method: string, params: Record<string, unknown>, id: number | string = 1): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params };
}

async function mcpInject(
  app: ReturnType<typeof buildApp>, token: string | undefined, body: Record<string, unknown>,
  extra: { origin?: string } = {},
) {
  return app.inject({
    method: 'POST', url: '/mcp',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(extra.origin ? { origin: extra.origin } : {}),
    },
    payload: body,
  });
}

interface JsonRpcToolCallBody { result?: { content?: { type: string; text: string }[]; isError?: boolean }; error?: unknown }
function toolCallResult(response: { body: string }): { parsed: unknown; isError: boolean } {
  const body = JSON.parse(response.body) as JsonRpcToolCallBody;
  const text = body.result?.content?.[0]?.text ?? '';
  return { parsed: JSON.parse(text.replace(/^UNTRUSTED_TOOL_DATA\n/, '')), isError: body.result?.isError ?? false };
}

function defaultApp() {
  return trackApp(buildApp(parseConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), undefined, { authConfig, database: client }));
}

describe('MCP authentication', () => {
  it('rejects a request with no Authorization header, including a WWW-Authenticate challenge', async () => {
    const app = defaultApp();
    const response = await mcpInject(app, undefined, rpc('tools/list', {}));
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain('Bearer');
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('rejects an expired access token', async () => {
    const app = defaultApp();
    const ctx = await context();
    const expired = await new SignJWT({ tenantId: ctx.tenantId, userId: ctx.userId, roles: ctx.roles })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuedAt(0).setExpirationTime(1)
      .setIssuer(authConfig.JWT_ISSUER).setAudience(authConfig.JWT_AUDIENCE)
      .sign(new TextEncoder().encode(authConfig.JWT_SECRET));
    const response = await mcpInject(app, expired, rpc('tools/list', {}));
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBeDefined();
  });

  it('rejects an invalid (tampered) token', async () => {
    const app = defaultApp();
    const token = await tokenFor();
    const response = await mcpInject(app, `${token}x`, rpc('tools/list', {}));
    expect(response.statusCode).toBe(401);
  });

  it('accepts a valid access token', async () => {
    const app = defaultApp();
    const token = await tokenFor();
    const response = await mcpInject(app, token, rpc('tools/list', {}));
    expect(response.statusCode).toBe(200);
  });
});

describe('MCP Origin allowlist (DNS-rebinding protection)', () => {
  it('rejects a disallowed Origin header', async () => {
    const app = trackApp(buildApp(parseConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', MCP_ALLOWED_ORIGINS: 'https://allowed.example.invalid' }), undefined, { authConfig, database: client }));
    const token = await tokenFor();
    const response = await mcpInject(app, token, rpc('tools/list', {}), { origin: 'https://evil.example.invalid' });
    expect(response.statusCode).toBe(403);
  });

  it('accepts an allowed Origin header', async () => {
    const app = trackApp(buildApp(parseConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', MCP_ALLOWED_ORIGINS: 'https://allowed.example.invalid' }), undefined, { authConfig, database: client }));
    const token = await tokenFor();
    const response = await mcpInject(app, token, rpc('tools/list', {}), { origin: 'https://allowed.example.invalid' });
    expect(response.statusCode).toBe(200);
  });

  it('allows a request with no Origin header at all (non-browser clients)', async () => {
    const app = trackApp(buildApp(parseConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', MCP_ALLOWED_ORIGINS: 'https://allowed.example.invalid' }), undefined, { authConfig, database: client }));
    const token = await tokenFor();
    const response = await mcpInject(app, token, rpc('tools/list', {}));
    expect(response.statusCode).toBe(200);
  });
});

describe('MCP rate limiting', () => {
  it('returns 429 once the per-user MCP limit is exceeded', async () => {
    const app = trackApp(buildApp(parseConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MCP_MAX: '2', RATE_LIMIT_MAX: '1000' }), undefined, { authConfig, database: client }));
    const token = await tokenFor();
    await mcpInject(app, token, rpc('tools/list', {}, 1));
    await mcpInject(app, token, rpc('tools/list', {}, 2));
    const limited = await mcpInject(app, token, rpc('tools/list', {}, 3));
    expect(limited.statusCode).toBe(429);
  });
});

describe('tools/list', () => {
  it('exposes the five governed tools with no tenant, user, or role parameters, and accurate annotations', async () => {
    const app = defaultApp();
    const token = await tokenFor();
    const response = await mcpInject(app, token, rpc('tools/list', {}));
    expect(response.statusCode).toBe(200);
    const body = response.json<{ result: { tools: { name: string; description?: string; inputSchema: { properties?: Record<string, unknown> }; annotations?: Record<string, unknown> }[] } }>();
    const toolsList = body.result.tools;
    expect(toolsList.map((tool) => tool.name).sort()).toEqual(['audit_activity', 'crm_search', 'kb_search', 'sql_analytics', 'task_draft']);
    const forbidden = ['tenant', 'tenantId', 'tenant_id', 'userId', 'user_id', 'role', 'roles', 'permissions', 'departmentId', 'employeeId'];
    for (const tool of toolsList) {
      const fields = Object.keys(tool.inputSchema.properties ?? {});
      expect(fields.some((field) => forbidden.includes(field))).toBe(false);
    }
    for (const tool of toolsList) {
      if (tool.name === 'task_draft') expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      else expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    const draft = toolsList.find((tool) => tool.name === 'task_draft');
    expect(draft?.description).toMatch(/no approve or execute tool/i);
  });
});

describe('tenant isolation over MCP', () => {
  it("cannot read another tenant's record through crm_search", async () => {
    const app = defaultApp();
    const token = await tokenFor();
    const [foreign] = await drizzle(ownerPool).select({ id: deals.id }).from(deals).where(eq(deals.tenantId, other.id)).limit(1);
    if (!foreign) throw new Error('Missing foreign-tenant fixture deal');
    const response = await mcpInject(app, token, rpc('tools/call', { name: 'crm_search', arguments: { entity: 'deals', id: foreign.id, limit: 1 } }));
    expect(response.statusCode).toBe(200);
    const { parsed, isError } = toolCallResult(response);
    expect(isError).toBe(false);
    expect(parsed).toEqual({ rows: [] });
  });
});

describe('task_draft over MCP', () => {
  it('creates a pending_action and leaves the tasks table unchanged', async () => {
    const app = defaultApp();
    const ctx = await context('rep1@example.invalid');
    const token = await signAccessToken(authConfig, { tenantId: ctx.tenantId, userId: ctx.userId, roles: ctx.roles });
    if (!ctx.employeeId) throw new Error('Missing rep employeeId fixture');
    const tasksBefore = await drizzle(ownerPool).select({ id: tasks.id }).from(tasks).where(eq(tasks.tenantId, tenant.id));
    const dueAt = new Date(Date.now() + 86400000).toISOString();
    const response = await mcpInject(app, token, rpc('tools/call', {
      name: 'task_draft',
      arguments: { title: 'Follow up', description: 'Call the customer back', assigneeEmployeeId: ctx.employeeId, dueAt },
    }));
    expect(response.statusCode).toBe(200);
    const { parsed, isError } = toolCallResult(response);
    expect(isError).toBe(false);
    const draft = z.object({ pendingActionId: z.uuid(), status: z.literal('pending') }).parse(parsed);
    const [stored] = await drizzle(ownerPool).select().from(pendingActions).where(eq(pendingActions.id, draft.pendingActionId));
    expect(stored).toBeDefined();
    expect(stored?.status).toBe('pending');
    const [taskRow] = await drizzle(ownerPool).select().from(tasks).where(eq(tasks.id, draft.pendingActionId));
    expect(taskRow).toBeUndefined();
    const tasksAfter = await drizzle(ownerPool).select({ id: tasks.id }).from(tasks).where(eq(tasks.tenantId, tenant.id));
    expect(tasksAfter.length).toBe(tasksBefore.length);
  });
});

describe('sql_analytics guard over MCP', () => {
  it('rejects a DML question and logs the rejection', async () => {
    const model = new MockLanguageModelV4({ doGenerate: modelText('UPDATE deals SET amount = 0') });
    const app = trackApp(buildApp(parseConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), undefined, { authConfig, database: client, agentModel: () => model }));
    const token = await tokenFor();
    const testStartedAt = new Date();
    const response = await mcpInject(app, token, rpc('tools/call', { name: 'sql_analytics', arguments: { question: 'Zero out every deal amount' } }));
    expect(response.statusCode).toBe(200);
    const { parsed, isError } = toolCallResult(response);
    expect(isError).toBe(true);
    expect(parsed).toMatchObject({ refused: true });
    const rejected = await drizzle(ownerPool).select().from(sqlExecutionLog)
      .where(and(eq(sqlExecutionLog.tenantId, tenant.id), eq(sqlExecutionLog.verdict, 'rejected'), gte(sqlExecutionLog.createdAt, testStartedAt)))
      .orderBy(desc(sqlExecutionLog.createdAt)).limit(1);
    expect(rejected.length).toBe(1);
  });
});

describe('kb_search ACL over MCP', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcp-kb-'));
    const fixture = (title: string, body: string, allowed: string[]) => `---\ntitle: ${title}\nallowed_roles: [${allowed.join(', ')}]\n---\n${body}\n`;
    await writeFile(join(directory, 'restricted.md'), fixture('Manager policy', '# Secret\nconfidential salary budget review', ['admin', 'sales_manager']));
    await createIngestor(client, new FakeEmbedder())(await context(), directory);
  }, 60000);
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it('refuses a rep but answers a manager for the same manager-only document', async () => {
    const kbAnswer = createKbAnswerer({ database: client, embedder: new FakeEmbedder(), llm: () => Promise.resolve('Budgets are confidential. [Manager policy §1]'), threshold: 0 });
    const app = trackApp(buildApp(parseConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), undefined, { authConfig, database: client, agentKbAnswer: kbAnswer }));
    const question = { question: 'confidential salary budget review' };

    const repToken = await tokenFor('rep1@example.invalid');
    const repResponse = await mcpInject(app, repToken, rpc('tools/call', { name: 'kb_search', arguments: question }));
    const repResult = toolCallResult(repResponse);
    expect(repResult.parsed).toMatchObject({ refused: true });

    const managerToken = await tokenFor('manager1@example.invalid');
    const managerResponse = await mcpInject(app, managerToken, rpc('tools/call', { name: 'kb_search', arguments: question }));
    const managerResult = toolCallResult(managerResponse);
    expect(managerResult.isError).toBe(false);
    expect(managerResult.parsed).toMatchObject({ refused: false });
    expect((managerResult.parsed as { answer: string }).answer).toContain('Manager policy');
  });
});

describe('REST/MCP parity', () => {
  it('returns identical rows for the same crm_search call via the reused tool and via MCP', async () => {
    const app = defaultApp();
    const ctx = await context();
    const token = await tokenFor();
    const direct = createCrmSearchTool(ctx, client);
    if (!direct.execute) throw new Error('Missing direct tool execute');
    const directResult = await direct.execute({ entity: 'deals', limit: 5 }, invocation);
    const response = await mcpInject(app, token, rpc('tools/call', { name: 'crm_search', arguments: { entity: 'deals', limit: 5 } }));
    const { parsed } = toolCallResult(response);
    // Round-trip the direct result through JSON too: MCP's content is always text/JSON, so Date
    // instances there are ISO strings, not Date objects.
    expect(parsed).toEqual(JSON.parse(JSON.stringify(directResult)));
  });
});

describe('MCP tool-call auditing', () => {
  it('writes an audit_logs row with channel mcp for a tool call', async () => {
    const app = defaultApp();
    const token = await tokenFor();
    const testStartedAt = new Date();
    const response = await mcpInject(app, token, rpc('tools/call', { name: 'crm_search', arguments: { entity: 'deals', limit: 1 } }));
    expect(response.statusCode).toBe(200);
    const rows = await drizzle(ownerPool).select().from(auditLogs)
      .where(and(eq(auditLogs.tenantId, tenant.id), eq(auditLogs.action, 'mcp.tool_call'), gte(auditLogs.createdAt, testStartedAt)));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => (row.details as { channel?: string }).channel === 'mcp')).toBe(true);
  });
});

describe('Method not allowed', () => {
  it.each(['GET', 'DELETE'] as const)('rejects %s /mcp with 405 in stateless mode', async (method) => {
    const app = defaultApp();
    const token = await tokenFor();
    const response = await app.inject({ method, url: '/mcp', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(405);
  });
});
