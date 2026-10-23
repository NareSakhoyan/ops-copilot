import { randomUUID } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadContext } from '../src/auth/context.js';
import { createDbClient } from '../src/db/client.js';
import { seedDatabase } from '../src/db/seed/index.js';
import { demoTenants } from '../src/db/seed/data.js';
import { permissions, rolePermissions, roles, userRoles, users } from '../src/db/schema/identity.js';
import { sqlExecutionLog } from '../src/db/schema/analytics-log.js';
import { createAnalyticsRunner, runAnalyticsQuery } from '../src/sql-guard/execute.js';
import { runMigrations, startTestDatabase } from './helpers/database.js';

const tenant = demoTenants[0];
const other = demoTenants[1];
let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let client: ReturnType<typeof createDbClient>;
let run: ReturnType<typeof createAnalyticsRunner>;
let databaseUrl: string;

beforeAll(async () => {
  container = await startTestDatabase('analytics_test');
  ownerPool = new Pool({ connectionString: container.getConnectionUri() });
  runMigrations(container);
  await drizzle(ownerPool).execute(sql`ALTER ROLE app_user PASSWORD 'analytics-test-only-password'`);
  const url = new URL(container.getConnectionUri());
  url.username = 'app_user'; url.password = 'analytics-test-only-password';
  databaseUrl = url.toString();
  client = createDbClient(databaseUrl, 1);
  await seedDatabase(client);
  run = createAnalyticsRunner(client);
}, 180000);

afterAll(async () => {
  vi.unstubAllEnvs();
  try { await client?.close(); await ownerPool?.end(); }
  finally { if (container) await container.stop(); }
}, 30000);

async function context(email = 'admin@example.invalid', tenantId: string = tenant.id) {
  return client.withTenant({ tenant_id: tenantId, user_id: tenant.adminId }, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.email, email));
    if (!user) throw new Error('Missing analytics fixture');
    const ctx = await loadContext(tx, tenantId, user.id, randomUUID());
    if (!ctx) throw new Error('Missing analytics context');
    return ctx;
  });
}

function raw(query: string) {
  return client.withTenant({ tenant_id: tenant.id, user_id: tenant.adminId }, async (tx) => {
    await tx.execute(sql`SELECT set_config('app.analytics_scope', 'tenant', true)`);
    await tx.execute(sql`SET LOCAL ROLE analytics_ro`);
    return tx.execute(sql.raw(query)); // Deliberately bypass the validator using fixed test SQL.
  });
}

describe('analytics database privileges without the validator', () => {
  it('creates four invoker/barrier views and exposes no sensitive columns', async () => {
    const result = await drizzle(ownerPool).execute(sql`
      SELECT c.relname, c.reloptions,
        has_table_privilege('analytics_ro', c.oid, 'INSERT, UPDATE, DELETE') AS writable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='v' ORDER BY c.relname
    `);
    const views = z.array(z.object({ relname: z.string(), reloptions: z.array(z.string()), writable: z.literal(false) })).parse(result.rows);
    expect(views.map((view) => view.relname)).toEqual(['v_contacts_activity', 'v_deals', 'v_employee_performance', 'v_tasks']);
    for (const view of views) expect(view.reloptions).toEqual(expect.arrayContaining(['security_invoker=true', 'security_barrier=true']));
    for (const name of views.map((view) => view.relname)) {
      const rows = (await raw(`SELECT * FROM public.${name} LIMIT 1`)).rows;
      expect(rows).toHaveLength(1);
      const keys = Object.keys(z.record(z.string(), z.unknown()).parse(rows[0]));
      expect(keys.filter((key) => ['email', 'phone', 'note', 'description', 'password_hash'].includes(key))).toEqual([]);
    }
  });

  it('grants exactly the columns used by the view definitions, including joins and filters', async () => {
    const db = drizzle(ownerPool);
    const required = await db.execute(sql`
      SELECT DISTINCT t.relname AS table_name, a.attname AS column_name
      FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid
      JOIN pg_class v ON v.oid=r.ev_class JOIN pg_class t ON t.oid=d.refobjid AND t.relkind='r'
      JOIN pg_namespace n ON n.oid=t.relnamespace AND n.nspname='public'
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
      WHERE v.relname IN ('v_deals','v_tasks','v_contacts_activity','v_employee_performance')
        AND d.refclassid='pg_class'::regclass ORDER BY table_name, column_name
    `);
    const actual = await db.execute(sql`
      SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname='public' AND c.relkind='r'
        AND has_column_privilege('analytics_ro', c.oid, a.attnum, 'SELECT') ORDER BY table_name, column_name
    `);
    expect(actual.rows).toEqual(required.rows);
    expect(actual.rows.length).toBeGreaterThan(0);
    runMigrations(container);
    expect((await raw('SELECT count(*) AS count FROM v_deals')).rows).toHaveLength(1);
  });

  it.each([
    'SELECT * FROM deals', 'SELECT * FROM tasks', 'SELECT * FROM contacts', 'SELECT * FROM activities', 'SELECT * FROM employees',
    'SELECT email FROM contacts', 'SELECT phone FROM contacts', 'SELECT note FROM activities',
    'SELECT description FROM tasks', 'SELECT lost_reason FROM deals', 'SELECT user_id FROM employees',
    'SELECT * FROM users', 'SELECT * FROM refresh_tokens', 'SELECT * FROM audit_logs',
    'SELECT * FROM pending_actions', 'SELECT * FROM sql_execution_log', 'SELECT * FROM companies', 'SELECT * FROM products',
    "UPDATE deals SET amount=0", 'DELETE FROM deals', 'TRUNCATE deals',
    "INSERT INTO deals (tenant_id, amount, currency, title) VALUES ('a0000000-0000-4000-8000-000000000001', 1, 'AMD', 'bad')",
    'DELETE FROM v_deals', "UPDATE v_tasks SET status='done'", 'ALTER TABLE deals ADD COLUMN bad text', 'DROP TABLE deals',
  ])('blocks raw access outside the column/read boundary: %s', async (query) => {
    const code = query === 'DELETE FROM v_deals' || query === "UPDATE v_tasks SET status='done'" ? '55000' : '42501';
    await expect(raw(query)).rejects.toMatchObject({ cause: { code } });
  });

  it('allows required base columns but applies tenant RLS even without a WHERE clause', async () => {
    const result = await raw('SELECT id, tenant_id, amount FROM deals');
    const rows = z.array(z.object({ id: z.uuid(), tenant_id: z.uuid() })).parse(result.rows);
    expect(rows).toHaveLength(600);
    expect(rows.every((row) => row.tenant_id === tenant.id)).toBe(true);
    expect((await raw(`SELECT id FROM deals WHERE tenant_id='${other.id}'`)).rows).toEqual([]);
    expect((await client.db.execute(sql`SELECT id FROM v_deals`)).rows).toEqual([]);
    expect((await client.withTenant({ tenant_id: tenant.id, user_id: tenant.adminId }, (tx) => tx.execute(sql`SELECT id FROM v_deals`))).rows).toEqual([]);
    await client.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE analytics_ro`);
      expect((await tx.execute(sql`SELECT id FROM deals`)).rows).toEqual([]);
    });
  });
});

describe('guarded analytics execution', () => {
  it('caps rows, excludes other tenants, binds literals, and logs the question and accepted query', async () => {
    const ctx = await context();
    const query = 'SELECT * FROM v_deals ORDER BY id';
    const rows = z.array(z.object({ tenant_id: z.uuid() })).parse(await run(ctx, query, 'Ցույց տուր գործարքները / Show deals'));
    expect(rows).toHaveLength(200);
    expect(rows.every((row) => row.tenant_id === tenant.id)).toBe(true);
    expect(await run(ctx, `SELECT id FROM v_deals WHERE tenant_id='${other.id}'`)).toEqual([]);
    expect(await run(ctx, "SELECT 'O''Reilly; DROP TABLE deals' AS label FROM v_deals LIMIT 1")).toEqual([{ label: "O'Reilly; DROP TABLE deals" }]);
    const [entry] = await drizzle(ownerPool).select().from(sqlExecutionLog).where(and(eq(sqlExecutionLog.requestId, ctx.requestId), eq(sqlExecutionLog.sql, query)));
    expect(entry).toMatchObject({ tenantId: tenant.id, userId: ctx.userId, question: 'Ցույց տուր գործարքները / Show deals', sql: query, verdict: 'accepted', rows: 200, error: null });
    expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns planted scenario counts and exact employee performance totals through the views', async () => {
    const ctx = await context();
    const countRows = z.array(z.object({ count: z.coerce.number() }));
    expect(countRows.parse(await run(ctx, "SELECT count(*) AS count FROM v_deals WHERE status='lost' AND closed_at >= now() - interval '30 days'")))
      .toEqual([{ count: 20 }]);
    expect(countRows.parse(await run(ctx, 'SELECT count(*) AS count FROM v_tasks'))).toEqual([{ count: 500 }]);
    expect(countRows.parse(await run(ctx, "SELECT count(*) AS count FROM v_contacts_activity WHERE last_activity_at IS NULL OR last_activity_at < now() - interval '14 days'")))
      .toEqual([{ count: 10 }]);
    const expected = await drizzle(ownerPool).execute(sql`
      SELECT currency, count(*) AS deals, count(*) FILTER (WHERE status='won') AS won,
        sum(amount) FILTER (WHERE status='won') AS revenue
      FROM deals WHERE tenant_id=${tenant.id} GROUP BY currency
    `);
    expect(await run(ctx, 'SELECT currency, sum(deal_count)::bigint AS deals, sum(won_count)::bigint AS won, sum(won_amount) AS revenue FROM v_employee_performance WHERE currency IS NOT NULL GROUP BY currency'))
      .toEqual(expected.rows);
  });

  it.each([
    ['admin@example.invalid', 600], ['manager1@example.invalid', 240], ['rep1@example.invalid', 120], ['viewer@example.invalid', 600],
  ] as const)('enforces freshly loaded scope for %s', async (email, expected) => {
    const ctx = await context(email);
    const result = await run({ ...ctx, roles: ['admin'], permissions: ['deals:aggregate', 'deals:read'] }, 'SELECT count(*) AS count FROM v_deals');
    expect(z.array(z.object({ count: z.coerce.number() })).parse(result)).toEqual([{ count: expected }]);
    if (email !== 'viewer@example.invalid') {
      const employees = await run(ctx, 'SELECT employee_id FROM v_employee_performance');
      if (email === 'rep1@example.invalid') expect(employees).toEqual([{ employee_id: ctx.employeeId }]);
      const contacts = await run(ctx, 'SELECT count(*) AS count FROM v_contacts_activity');
      expect(z.array(z.object({ count: z.coerce.number() })).parse(contacts)).toEqual([{ count: email === 'admin@example.invalid' ? 400 : email === 'manager1@example.invalid' ? 160 : 80 }]);
    }
  });

  it('rejects viewer detail extraction and persists rejected verdicts', async () => {
    const ctx = await context('viewer@example.invalid');
    for (const query of ['SELECT * FROM v_deals', 'SELECT id, count(*) FROM v_deals GROUP BY id', 'SELECT max(name) FROM v_contacts_activity']) {
      await expect(run(ctx, query)).rejects.toMatchObject({ statusCode: 400 });
    }
    const entries = await drizzle(ownerPool).select().from(sqlExecutionLog).where(eq(sqlExecutionLog.requestId, ctx.requestId));
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.verdict === 'rejected' && entry.rows === 0 && entry.question === null)).toBe(true);
  });

  it('keeps mixed viewer/rep detail reads scoped to the rep while allowing tenant aggregates', async () => {
    const ctx = await context('rep1@example.invalid');
    const db = drizzle(ownerPool);
    const [viewer] = await db.select().from(roles).where(and(eq(roles.tenantId, tenant.id), eq(roles.name, 'viewer')));
    if (!viewer) throw new Error('Missing viewer fixture');
    await db.insert(userRoles).values({ tenantId: tenant.id, userId: ctx.userId, roleId: viewer.id });
    try {
      expect(await run(ctx, 'SELECT id FROM v_deals')).toHaveLength(120);
      expect(z.array(z.object({ count: z.coerce.number() })).parse(await run(ctx, 'SELECT count(*) AS count FROM v_deals'))).toEqual([{ count: 600 }]);
    } finally {
      await db.delete(userRoles).where(and(eq(userRoles.userId, ctx.userId), eq(userRoles.roleId, viewer.id)));
    }
  });

  it('logs validator rejections and execution errors without leaking database details', async () => {
    const ctx = await context();
    await expect(run(ctx, 'SELECT * FROM users')).rejects.toMatchObject({ statusCode: 400 });
    await expect(run(ctx, "SELECT 'private-value'::integer FROM v_deals")).rejects.toMatchObject({ statusCode: 422 });
    const entries = await drizzle(ownerPool).select().from(sqlExecutionLog).where(eq(sqlExecutionLog.requestId, ctx.requestId));
    expect(entries.map((entry) => entry.verdict).sort()).toEqual(['error', 'rejected']);
    expect(entries.every((entry) => entry.error !== null && !entry.error.includes('private-value'))).toBe(true);
    expect(await run(ctx, 'SELECT count(*) AS count FROM v_deals')).toHaveLength(1);
  });

  it('revalidates permissions instead of trusting stale or supplied context grants', async () => {
    const ctx = await context('rep1@example.invalid');
    const db = drizzle(ownerPool);
    const [role] = await db.select().from(roles).where(and(eq(roles.tenantId, tenant.id), eq(roles.name, 'sales_rep')));
    const [permission] = await db.select().from(permissions).where(and(eq(permissions.tenantId, tenant.id), eq(permissions.code, 'deals:aggregate')));
    if (!role || !permission) throw new Error('Missing permission fixture');
    await db.delete(rolePermissions).where(and(eq(rolePermissions.roleId, role.id), eq(rolePermissions.permissionId, permission.id)));
    try { await expect(run(ctx, 'SELECT count(*) FROM v_deals')).rejects.toMatchObject({ statusCode: 403 }); }
    finally { await db.insert(rolePermissions).values({ tenantId: tenant.id, roleId: role.id, permissionId: permission.id }); }
    const entries = await db.select().from(sqlExecutionLog).where(eq(sqlExecutionLog.requestId, ctx.requestId));
    expect(entries).toMatchObject([{ verdict: 'rejected', rows: 0 }]);
  });

  it('never resolves allowed function/operator syntax to public overloads', async () => {
    const db = drizzle(ownerPool);
    await db.execute(sql`CREATE FUNCTION public.sum(text) RETURNS text LANGUAGE SQL AS $$ SELECT 'unexpected overload'::text $$`);
    await db.execute(sql`CREATE FUNCTION public.negate_text(text) RETURNS numeric LANGUAGE SQL AS $$ SELECT 999999::numeric $$`);
    await db.execute(sql`CREATE OPERATOR public.- (RIGHTARG=text, FUNCTION=public.negate_text)`);
    try {
      await expect(run(await context(), 'SELECT sum(title) FROM v_deals')).rejects.toMatchObject({ statusCode: 422 });
      await expect(run(await context(), 'SELECT -title FROM v_deals')).rejects.toMatchObject({ statusCode: 422 });
      const negative = z.array(z.object({ negative: z.coerce.number().negative() })).parse(await run(await context(), 'SELECT -amount AS negative FROM v_deals LIMIT 1'));
      expect(negative).toHaveLength(1);
    } finally {
      await db.execute(sql`DROP OPERATOR public.- (NONE, text)`);
      await db.execute(sql`DROP FUNCTION public.negate_text(text)`);
      await db.execute(sql`DROP FUNCTION public.sum(text)`);
    }
  });

  it('preserves GROUP BY and ORDER BY ordinals while binding value literals', async () => {
    const result = z.array(z.object({ status: z.string(), count: z.coerce.number() })).parse(
      await run(await context('viewer@example.invalid'), 'SELECT status, count(*) AS count FROM v_deals GROUP BY 1 ORDER BY 1'));
    expect(result.map((row) => row.status)).toEqual(['lost', 'open', 'won']);
    expect(result.reduce((sum, row) => sum + row.count, 0)).toBe(600);
  });

  it('preserves exact decimal and large integer literals instead of rounding through JavaScript', async () => {
    expect(await run(await context(), 'SELECT 12345678901234567890.0123456789 AS amount, 9223372036854775808 AS large, -17 AS signed'))
      .toEqual([{ amount: '12345678901234567890.0123456789', large: '9223372036854775808', signed: -17 }]);
  });

  it('enforces a real five-second timeout and commits the error log after query rollback', async () => {
    const ctx = await context();
    await expect(run(ctx, 'SELECT sum(a.amount*b.amount*c.amount*d.amount) FROM v_deals a CROSS JOIN v_deals b CROSS JOIN v_deals c CROSS JOIN v_deals d'))
      .rejects.toMatchObject({ statusCode: 504 });
    const [entry] = await drizzle(ownerPool).select().from(sqlExecutionLog).where(eq(sqlExecutionLog.requestId, ctx.requestId));
    expect(entry).toMatchObject({ verdict: 'error', rows: 0, error: 'Analytics query timed out' });
    expect(entry?.durationMs).toBeGreaterThanOrEqual(4500);
    expect(await run(ctx, 'SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
  }, 15000);

  it('resets role, tenant/scope settings and timeout before reusing its connection', async () => {
    await run(await context(), 'SELECT count(*) FROM v_deals');
    const settings = await client.db.execute(sql`
      SELECT current_user AS role, current_setting('app.tenant_id',true) AS tenant,
        current_setting('app.analytics_scope',true) AS scope, current_setting('statement_timeout') AS timeout
    `);
    expect(settings.rows).toEqual([{ role: 'app_user', tenant: '', scope: '', timeout: '0' }]);
    const ctxB = await context('admin@example.invalid', other.id);
    const result = z.array(z.object({ tenant_id: z.uuid() })).parse(await run(ctxB, 'SELECT tenant_id FROM v_deals'));
    expect(result.every((row) => row.tenant_id === other.id)).toBe(true);
    const visibleLogs = await client.withTenant({ tenant_id: other.id, user_id: ctxB.userId }, (tx) => tx.select().from(sqlExecutionLog));
    expect(visibleLogs).toHaveLength(1);
    expect(visibleLogs.every((entry) => entry.tenantId === other.id)).toBe(true);
  });

  it('wires the public runAnalyticsQuery helper to the lazy application database', async () => {
    const ctx = await context();
    vi.stubEnv('DATABASE_URL', databaseUrl);
    try { expect(await runAnalyticsQuery(ctx, 'SELECT 1 AS ok')).toEqual([{ ok: 1 }]); }
    finally {
      const { closeDatabase } = await import('../src/db/client.js');
      await closeDatabase();
      vi.unstubAllEnvs();
    }
  });
});
