import { randomUUID } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activities, companies, contacts, deals, leads, tasks } from '../src/db/schema/crm.js';
import { permissions, rolePermissions, roles, userRoles, users } from '../src/db/schema/identity.js';
import { orderItems, orders, products } from '../src/db/schema/orders.js';
import { auditLogs, refreshTokens } from '../src/db/schema/security.js';
import { tenants } from '../src/db/schema/tenants.js';
import { departments, employees } from '../src/db/schema/workforce.js';
import { runMigrations, startTestDatabase } from './helpers/database.js';

const expectedTables = [
  'activities', 'audit_logs', 'companies', 'contacts', 'deals', 'departments', 'employees',
  'leads', 'order_items', 'orders', 'permissions', 'products', 'refresh_tokens',
  'role_permissions', 'roles', 'tasks', 'tenants', 'user_roles', 'users',
].sort();

function fixtureIds() {
  return {
    tenantId: randomUUID(), userId: randomUUID(), roleId: randomUUID(), permissionId: randomUUID(),
    departmentId: randomUUID(), employeeId: randomUUID(), companyId: randomUUID(), contactId: randomUUID(),
    leadId: randomUUID(), dealId: randomUUID(), productId: randomUUID(), orderId: randomUUID(),
  };
}

const tenantA = fixtureIds();
const tenantB = fixtureIds();
let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let initialTables: string[];

async function publicTables(): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `);
  return z.array(z.object({ name: z.string() })).parse(result.rows).map((row) => row.name);
}

beforeAll(async () => {
  container = await startTestDatabase('ops_copilot_test');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  initialTables = await publicTables();
  runMigrations(container);

  for (const [index, fixture] of [tenantA, tenantB].entries()) {
    const tenantId = fixture.tenantId;
    await db.insert(tenants).values({ id: tenantId, name: `Tenant ${index}` });
    await db.insert(users).values({ id: fixture.userId, tenantId, name: 'Manager', email: 'manager@example.invalid', passwordHash: 'test-hash' });
    await db.insert(roles).values({ id: fixture.roleId, tenantId, name: 'manager' });
    await db.insert(permissions).values({ id: fixture.permissionId, tenantId, code: 'crm.read', description: 'Read CRM' });
    await db.insert(userRoles).values({ tenantId, userId: fixture.userId, roleId: fixture.roleId });
    await db.insert(rolePermissions).values({ tenantId, roleId: fixture.roleId, permissionId: fixture.permissionId });
    await db.insert(departments).values({ id: fixture.departmentId, tenantId, name: 'Sales' });
    await db.insert(employees).values({ id: fixture.employeeId, tenantId, name: 'Manager', userId: fixture.userId, departmentId: fixture.departmentId });
    await db.insert(companies).values({ id: fixture.companyId, tenantId, name: 'Customer' });
    await db.insert(contacts).values({ id: fixture.contactId, tenantId, name: 'Contact', companyId: fixture.companyId });
    await db.insert(leads).values({ id: fixture.leadId, tenantId, title: 'Lead', contactId: fixture.contactId, companyId: fixture.companyId, responsibleEmployeeId: fixture.employeeId });
    await db.insert(deals).values({ id: fixture.dealId, tenantId, title: 'Deal', amount: '100.00', currency: 'USD', leadId: fixture.leadId, contactId: fixture.contactId, companyId: fixture.companyId, responsibleEmployeeId: fixture.employeeId });
    await db.insert(activities).values({ tenantId, type: 'call', contactId: fixture.contactId, dealId: fixture.dealId, employeeId: fixture.employeeId, occurredAt: new Date(), note: 'Follow-up' });
    await db.insert(tasks).values({ tenantId, description: 'Call customer', assigneeEmployeeId: fixture.employeeId, dueAt: new Date(), contactId: fixture.contactId, dealId: fixture.dealId });
    await db.insert(products).values({ id: fixture.productId, tenantId, name: 'Product', sku: 'SKU-1', price: '100.00', currency: 'USD' });
    await db.insert(orders).values({ id: fixture.orderId, tenantId, companyId: fixture.companyId, contactId: fixture.contactId, dealId: fixture.dealId, amount: '100.00', currency: 'USD' });
    await db.insert(orderItems).values({ tenantId, orderId: fixture.orderId, productId: fixture.productId, quantity: 1, unitPrice: '100.00', currency: 'USD' });
    await db.insert(auditLogs).values({ tenantId, actorUserId: fixture.userId, action: 'create', entityType: 'deal', entityId: fixture.dealId });
    await db.insert(refreshTokens).values({ tenantId, userId: fixture.userId, tokenHash: 'test-token-hash', expiresAt: new Date(Date.now() + 3600000) });
  }
}, 180000);

afterAll(async () => {
  try {
    if (pool) await pool.end();
  } finally {
    if (container) await container.stop();
  }
}, 30000);

describe('owner migrations and bootstrap', () => {
  it('applies the committed migrations to an empty database', async () => {
    expect(initialTables).toEqual([]);
    expect(await publicTables()).toEqual(expectedTables);
    const result = await db.execute(sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    expect(z.array(z.object({ extname: z.literal('vector') })).parse(result.rows)).toHaveLength(1);
  });

  it('can run again without losing existing records', async () => {
    runMigrations(container);
    const records = await db.select({ id: tenants.id }).from(tenants);
    expect(records.map((record) => record.id).sort()).toEqual([tenantA.tenantId, tenantB.tenantId].sort());
  });

  it('creates the restricted login and non-login analytics role', async () => {
    const result = await db.execute(sql`
      SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname IN ('app_user', 'analytics_ro') ORDER BY rolname
    `);
    const records = z.array(z.object({
      rolname: z.string(), rolcanlogin: z.boolean(), rolsuper: z.boolean(), rolbypassrls: z.boolean(),
    })).parse(result.rows);
    expect(records).toEqual([
      { rolname: 'analytics_ro', rolcanlogin: false, rolsuper: false, rolbypassrls: false },
      { rolname: 'app_user', rolcanlogin: true, rolsuper: false, rolbypassrls: false },
    ]);
  });

  it('allows app_user to SET LOCAL ROLE analytics_ro and restores the role afterward', async () => {
    const membership = await db.execute(sql`SELECT pg_has_role('app_user', 'analytics_ro', 'SET') AS allowed`);
    expect(z.array(z.object({ allowed: z.boolean() })).parse(membership.rows)).toEqual([{ allowed: true }]);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(sql`SET LOCAL ROLE analytics_ro`);
      const result = await tx.execute(sql`SELECT current_user AS name`);
      expect(z.array(z.object({ name: z.string() })).parse(result.rows)).toEqual([{ name: 'analytics_ro' }]);
    });
    const result = await db.execute(sql`SELECT current_user AS name`);
    expect(z.array(z.object({ name: z.string() })).parse(result.rows)).toEqual([{ name: 'migration_owner' }]);
  });

  it('gives app_user table DML privileges through owner defaults', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantA.tenantId}, true)`);
      const id = randomUUID();
      await tx.insert(companies).values({ id, tenantId: tenantA.tenantId, name: 'Runtime company' });
      await tx.update(companies).set({ name: 'Updated' }).where(eq(companies.id, id));
      expect(await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, id)))
        .toEqual([{ name: 'Updated' }]);
      await tx.delete(companies).where(eq(companies.id, id));
    });
  });

  it('leaves analytics table grants empty for now', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE analytics_ro`);
      await tx.select().from(companies);
    })).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('tenant boundaries', () => {
  const crossTenantReferences = [
    { name: 'contact/company', insert: () => db.insert(contacts).values({ tenantId: tenantA.tenantId, name: 'Invalid', companyId: tenantB.companyId }) },
    { name: 'task/assignee', insert: () => db.insert(tasks).values({ tenantId: tenantA.tenantId, description: 'Invalid', assigneeEmployeeId: tenantB.employeeId, dueAt: new Date() }) },
    { name: 'activity/contact', insert: () => db.insert(activities).values({ tenantId: tenantA.tenantId, type: 'call', contactId: tenantB.contactId, occurredAt: new Date(), note: 'Invalid' }) },
    { name: 'user/role', insert: () => db.insert(userRoles).values({ tenantId: tenantA.tenantId, userId: tenantA.userId, roleId: tenantB.roleId }) },
    { name: 'role/permission', insert: () => db.insert(rolePermissions).values({ tenantId: tenantA.tenantId, roleId: tenantA.roleId, permissionId: tenantB.permissionId }) },
    { name: 'employee/department', insert: () => db.insert(employees).values({ tenantId: tenantA.tenantId, name: 'Invalid', departmentId: tenantB.departmentId }) },
    { name: 'refresh token/user', insert: () => db.insert(refreshTokens).values({ tenantId: tenantA.tenantId, userId: tenantB.userId, tokenHash: 'invalid-token', expiresAt: new Date() }) },
    { name: 'audit/actor', insert: () => db.insert(auditLogs).values({ tenantId: tenantA.tenantId, actorUserId: tenantB.userId, action: 'read', entityType: 'company' }) },
    { name: 'order item/product', insert: () => db.insert(orderItems).values({ tenantId: tenantA.tenantId, orderId: tenantA.orderId, productId: tenantB.productId, quantity: 1, unitPrice: '100.00', currency: 'USD' }) },
  ];

  it.each(crossTenantReferences)('rejects a cross-tenant $name reference', async ({ insert }) => {
    await expect(insert()).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('rejects duplicate natural identifiers within the same tenant', async () => {
    await expect(db.insert(users).values({ tenantId: tenantA.tenantId, name: 'Duplicate', email: 'manager@example.invalid', passwordHash: 'test-hash' }))
      .rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('accepts nullable optional relationships while keeping tenant_id mandatory', async () => {
    await expect(db.insert(contacts).values({ tenantId: tenantA.tenantId, name: 'Independent contact' }))
      .resolves.toBeDefined();
    await expect(db.execute(sql`INSERT INTO companies (name) VALUES (${'Missing tenant'})`))
      .rejects.toMatchObject({ cause: { code: '23502' } });
  });
});

describe('database checks', () => {
  it.each([
    { name: 'deal status', statement: sql`INSERT INTO deals (tenant_id, title, status, amount, currency) VALUES (${tenantA.tenantId}, 'Invalid', 'invalid', 1, 'USD')` },
    { name: 'task status', statement: sql`INSERT INTO tasks (tenant_id, description, assignee_employee_id, due_at, status) VALUES (${tenantA.tenantId}, 'Invalid', ${tenantA.employeeId}, now(), 'overdue')` },
    { name: 'activity type', statement: sql`INSERT INTO activities (tenant_id, type, contact_id, occurred_at, note) VALUES (${tenantA.tenantId}, 'invalid', ${tenantA.contactId}, now(), 'Invalid')` },
    { name: 'negative money', statement: sql`INSERT INTO deals (tenant_id, title, amount, currency) VALUES (${tenantA.tenantId}, 'Invalid', -1, 'USD')` },
    { name: 'currency format', statement: sql`INSERT INTO deals (tenant_id, title, amount, currency) VALUES (${tenantA.tenantId}, 'Invalid', 1, 'usd')` },
    { name: 'quantity', statement: sql`INSERT INTO order_items (tenant_id, order_id, product_id, quantity, unit_price, currency) VALUES (${tenantA.tenantId}, ${tenantA.orderId}, ${tenantA.productId}, 0, 1, 'USD')` },
  ])('rejects invalid $name', async ({ statement }) => {
    await expect(db.execute(statement)).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('stores exact money and populates timestamps and UUIDs', async () => {
    const records = await db.select().from(deals).where(eq(deals.id, tenantA.dealId));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ amount: '100.00', status: 'open' });
    expect(records[0]?.createdAt).toBeInstanceOf(Date);
    expect(records[0]?.updatedAt).toBeInstanceOf(Date);
    expect(z.uuid().safeParse(records[0]?.id).success).toBe(true);
  });

  it('creates the four requested query indexes, including descending activity time', async () => {
    const result = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
      AND indexname IN ('deals_tenant_status_created_at_idx', 'tasks_tenant_status_created_at_idx',
        'activities_tenant_contact_occurred_at_idx', 'tasks_tenant_due_at_idx')
    `);
    const records = z.array(z.object({ indexname: z.string(), indexdef: z.string() })).parse(result.rows);
    const definitions = Object.fromEntries(records.map((record) => [record.indexname, record.indexdef]));
    expect(records).toHaveLength(4);
    expect(definitions['deals_tenant_status_created_at_idx']).toContain('(tenant_id, status, created_at)');
    expect(definitions['tasks_tenant_status_created_at_idx']).toContain('(tenant_id, status, created_at)');
    expect(definitions['activities_tenant_contact_occurred_at_idx'])
      .toMatch(/\(tenant_id, contact_id, occurred_at DESC(?: NULLS LAST)?\)/);
    expect(definitions['tasks_tenant_due_at_idx']).toContain('(tenant_id, due_at)');
  });
});
