import { randomUUID } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { closeDatabase, createDbClient, withTenant } from '../src/db/client.js';
import { companies, deals } from '../src/db/schema/crm.js';
import { tenants } from '../src/db/schema/tenants.js';
import { users } from '../src/db/schema/identity.js';
import { runMigrations, startTestDatabase } from './helpers/database.js';

const contextA = { tenant_id: randomUUID(), user_id: randomUUID() };
const contextB = { tenant_id: randomUUID(), user_id: randomUUID() };
const companyA = randomUUID();
const companyB = randomUUID();
const dealA = randomUUID();
const dealB = randomUUID();
const dealRows = z.array(z.object({ id: z.uuid(), tenant_id: z.uuid() }));

let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let appClient: ReturnType<typeof createDbClient>;
let appDb: NodePgDatabase;
let ownerDb: NodePgDatabase;

let appDatabaseUrl: string;

beforeAll(async () => {
  container = await startTestDatabase('rls_test');
  ownerPool = new Pool({ connectionString: container.getConnectionUri() });
  ownerDb = drizzle(ownerPool);
  runMigrations(container);
  await ownerDb.execute(sql`ALTER ROLE app_user PASSWORD 'app-test-password'`);
  const appUrl = new URL(container.getConnectionUri());
  appUrl.username = 'app_user';
  appUrl.password = 'app-test-password';
  // A single connection makes post-transaction reuse deterministic.
  appDatabaseUrl = appUrl.toString();
  appClient = createDbClient(appDatabaseUrl, 1);
  appDb = appClient.db;
  await ownerDb.insert(tenants).values([
    { id: contextA.tenant_id, name: 'Tenant A' }, { id: contextB.tenant_id, name: 'Tenant B' },
  ]);
  await ownerDb.insert(companies).values([
    { id: companyA, tenantId: contextA.tenant_id, name: 'Company A' },
    { id: companyB, tenantId: contextB.tenant_id, name: 'Company B' },
  ]);
  await ownerDb.insert(deals).values([
    { id: dealA, tenantId: contextA.tenant_id, title: 'Deal A', amount: '10.00', currency: 'USD' },
    { id: dealB, tenantId: contextB.tenant_id, title: 'Deal B', amount: '20.00', currency: 'USD' },
  ]);
}, 180000);

afterAll(async () => {
  try {
    await Promise.all([appClient?.close(), ownerPool?.end(), closeDatabase()]);
    vi.unstubAllEnvs();
  } finally {
    if (container) await container.stop();
  }
}, 30000);

describe('tenant row-level security through a real app_user login', () => {
  it('connects as a non-owner, non-superuser without BYPASSRLS', async () => {
    const result = await appDb.execute(sql`
      SELECT current_user AS name, r.rolsuper, r.rolbypassrls,
        pg_get_userbyid(c.relowner) AS owner
      FROM pg_roles r CROSS JOIN pg_class c
      WHERE r.rolname = current_user AND c.oid = 'public.deals'::regclass
    `);
    expect(z.array(z.object({ name: z.string(), rolsuper: z.boolean(), rolbypassrls: z.boolean(), owner: z.string() })).parse(result.rows))
      .toEqual([{ name: 'app_user', rolsuper: false, rolbypassrls: false, owner: 'migration_owner' }]);
  });

  it('returns zero rows before any tenant context has been set', async () => {
    expect(dealRows.parse((await appDb.execute(sql`SELECT * FROM deals`)).rows)).toEqual([]);
  });

  it('isolates pending actions with and without tenant context and rejects cross-tenant writes', async () => {
    await ownerDb.insert(users).values([
      { id: contextA.user_id, tenantId: contextA.tenant_id, name: 'A', email: 'a@example.invalid', passwordHash: 'fixture-only' },
      { id: contextB.user_id, tenantId: contextB.tenant_id, name: 'B', email: 'b@example.invalid', passwordHash: 'fixture-only' },
    ]);
    await ownerDb.execute(sql`
      INSERT INTO pending_actions (tenant_id, user_id, payload)
      VALUES (${contextA.tenant_id}, ${contextA.user_id}, '{}'::jsonb),
        (${contextB.tenant_id}, ${contextB.user_id}, '{}'::jsonb)
    `);
    const result = await appClient.withTenant(contextA, (tx) => tx.execute(sql`SELECT * FROM pending_actions`));
    expect(z.array(z.object({ tenant_id: z.uuid(), user_id: z.uuid() })).parse(result.rows)).toEqual([contextA]);
    const ownInsert = await appClient.withTenant(contextA, (tx) => tx.execute(sql`
      INSERT INTO pending_actions (tenant_id, user_id, payload)
      VALUES (${contextA.tenant_id}, ${contextA.user_id}, '{}'::jsonb) RETURNING id
    `));
    expect(ownInsert.rows).toHaveLength(1);
    expect((await appDb.execute(sql`SELECT * FROM pending_actions`)).rows).toEqual([]);
    await expect(appClient.withTenant(contextA, (tx) => tx.execute(sql`
      INSERT INTO pending_actions (tenant_id, user_id, payload)
      VALUES (${contextB.tenant_id}, ${contextB.user_id}, '{}'::jsonb)
    `))).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(appClient.withTenant(contextA, (tx) => tx.execute(sql`
      UPDATE pending_actions SET tenant_id = ${contextB.tenant_id}, user_id = ${contextB.user_id}
    `))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('filters SELECT * FROM deals without a WHERE clause to tenant A', async () => {
    const result = await appClient.withTenant(contextA, (tx) => tx.execute(sql`SELECT * FROM deals`));
    expect(dealRows.parse(result.rows)).toEqual([{ id: dealA, tenant_id: contextA.tenant_id }]);
  });

  it('rejects an INSERT with another tenant_id', async () => {
    await expect(appClient.withTenant(contextA, (tx) => tx.insert(companies).values({ tenantId: contextB.tenant_id, name: 'Forbidden' })))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('returns zero rows outside the tenant transaction on a reused connection', async () => {
    await appClient.withTenant(contextA, (tx) => tx.execute(sql`SELECT * FROM deals`));
    expect(dealRows.parse((await appDb.execute(sql`SELECT * FROM deals`)).rows)).toEqual([]);
  });

  it('rejects writes without tenant context', async () => {
    await expect(appDb.insert(companies).values({ tenantId: contextA.tenant_id, name: 'No context' }))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('continues to reject cross-tenant composite foreign keys inside an allowed tenant', async () => {
    await expect(appClient.withTenant(contextA, (tx) => tx.execute(sql`
      INSERT INTO contacts (tenant_id, name, company_id) VALUES (${contextA.tenant_id}, 'Invalid link', ${companyB})
    `))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it.each([
    { name: 'ALTER', statement: sql`ALTER TABLE deals ADD COLUMN forbidden text` },
    { name: 'DROP', statement: sql`DROP TABLE deals` },
  ])('denies $name TABLE to app_user', async ({ statement }) => {
    await expect(appClient.withTenant(contextA, (tx) => tx.execute(statement)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('enables RLS without FORCE and has one policy on every tenant-scoped table', async () => {
    const result = await ownerDb.execute(sql`
      SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
        (SELECT count(*)::integer FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND (c.relname = 'tenants' OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      ))
    `);
    const rows = z.array(z.object({ name: z.string(), enabled: z.boolean(), forced: z.boolean(), policies: z.number() })).parse(result.rows);
    expect(rows.find((row) => row.name === 'tenants')).toEqual({ name: 'tenants', enabled: false, forced: false, policies: 0 });
    const tenantTables = rows.filter((row) => row.name !== 'tenants');
    expect(tenantTables).toHaveLength(22);
    for (const row of tenantTables) {
      expect(row, row.name).toMatchObject({ enabled: true, forced: false, policies: 1 });
    }
    const policyResult = await ownerDb.execute(sql`
      SELECT tablename, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public'
    `);
    const policies = z.array(z.object({
      tablename: z.string(), roles: z.array(z.string()), cmd: z.literal('ALL'), qual: z.string(), with_check: z.string(),
    })).parse(policyResult.rows);
    expect(policies).toHaveLength(22);
    for (const policy of policies) {
      expect(policy.roles.sort(), policy.tablename).toEqual(['analytics_ro', 'app_user']);
      expect(policy.qual, policy.tablename).toBe(policy.with_check);
    }
  });

  it('sets both IDs and returns callback results through the public withTenant helper', async () => {
    vi.stubEnv('DATABASE_URL', appDatabaseUrl);
    const rows = await withTenant(contextA, async (tx) => {
      const result = await tx.execute(sql`
        SELECT current_user AS role, current_setting('app.tenant_id') AS tenant_id,
          current_setting('app.user_id') AS user_id
      `);
      return z.array(z.object({ role: z.string(), tenant_id: z.uuid(), user_id: z.uuid() })).parse(result.rows);
    });
    expect(rows).toEqual([{ role: 'app_user', ...contextA }]);
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it('commits same-tenant writes', async () => {
    const id = randomUUID();
    await appClient.withTenant(contextA, (tx) => tx.insert(companies).values({ id, tenantId: contextA.tenant_id, name: 'Committed' }));
    const result = await ownerDb.execute(sql`SELECT id FROM companies WHERE id = ${id}`);
    expect(z.array(z.object({ id: z.uuid() })).parse(result.rows)).toEqual([{ id }]);
  });

  it('rolls back failed callbacks and clears context before reusing the connection', async () => {
    const id = randomUUID();
    await expect(appClient.withTenant(contextA, async (tx) => {
      await tx.insert(companies).values({ id, tenantId: contextA.tenant_id, name: 'Rolled back' });
      throw new Error('Callback failed');
    })).rejects.toThrow('Callback failed');
    expect((await ownerDb.execute(sql`SELECT id FROM companies WHERE id = ${id}`)).rows).toEqual([]);
    expect(dealRows.parse((await appDb.execute(sql`SELECT * FROM deals`)).rows)).toEqual([]);
    const result = await appClient.withTenant(contextB, (tx) => tx.execute(sql`SELECT * FROM deals`));
    expect(dealRows.parse(result.rows)).toEqual([{ id: dealB, tenant_id: contextB.tenant_id }]);
  });

  it('rejects missing, malformed, or injected context IDs before calling the callback', async () => {
    const callback = vi.fn(() => Promise.resolve('must not run'));
    await expect(appClient.withTenant({ tenant_id: '', user_id: contextA.user_id }, callback)).rejects.toThrow(z.ZodError);
    await expect(appClient.withTenant({ tenant_id: contextA.tenant_id, user_id: 'invalid' }, callback)).rejects.toThrow(z.ZodError);
    await expect(appClient.withTenant({ tenant_id: "'; RESET ROLE; --", user_id: contextA.user_id }, callback)).rejects.toThrow(z.ZodError);
    expect(callback).not.toHaveBeenCalled();
  });

  it('refuses owner credentials for the application client', () => {
    expect(() => createDbClient(container.getConnectionUri())).toThrow(z.ZodError);
    const overriddenOwner = new URL(container.getConnectionUri());
    overriddenOwner.username = 'app_user';
    overriddenOwner.searchParams.set('user', 'migration_owner');
    expect(() => createDbClient(overriddenOwner.toString())).toThrow(z.ZodError);
  });

  it('filters UPDATE and DELETE and prevents changing tenant_id', async () => {
    const updated = await appClient.withTenant(contextA, (tx) => tx.execute(sql`UPDATE deals SET title = 'Forbidden' WHERE id = ${dealB} RETURNING id`));
    const deleted = await appClient.withTenant(contextA, (tx) => tx.execute(sql`DELETE FROM deals WHERE id = ${dealB} RETURNING id`));
    expect(updated.rows).toEqual([]);
    expect(deleted.rows).toEqual([]);
    await expect(appClient.withTenant(contextA, (tx) => tx.execute(sql`
      UPDATE deals SET tenant_id = ${contextB.tenant_id} WHERE id = ${dealA}
    `))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('applies the same policy to analytics SELECT when a table grant is present', async () => {
    // Broaden to a table grant only inside this test; normal analytics grants are column-scoped.
    await ownerDb.execute(sql`GRANT SELECT ON deals TO analytics_ro`);
    try {
      const result = await appClient.withTenant(contextA, async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE analytics_ro`);
        return tx.execute(sql`SELECT * FROM deals`);
      });
      expect(dealRows.parse(result.rows)).toEqual([{ id: dealA, tenant_id: contextA.tenant_id }]);
      await expect(appClient.withTenant(contextA, async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE analytics_ro`);
        await tx.execute(sql`DELETE FROM deals`);
      })).rejects.toMatchObject({ cause: { code: '42501' } });
    } finally {
      await ownerDb.execute(sql`REVOKE SELECT ON deals FROM analytics_ro`);
    }
  });
});
