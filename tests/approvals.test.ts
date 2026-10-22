import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { parseAuthConfig } from '../src/auth/config.js';
import { loadContext } from '../src/auth/context.js';
import { signAccessToken } from '../src/auth/tokens.js';
import { createApprovalsService } from '../src/approvals/service.js';
import { createMockBitrix } from '../src/mock-bitrix/service.js';
import { HttpError } from '../src/routes/errors.js';
import { createDbClient } from '../src/db/client.js';
import { pendingActions } from '../src/db/schema/approvals.js';
import { contacts, deals, tasks } from '../src/db/schema/crm.js';
import { permissions, rolePermissions, roles, userRoles, users } from '../src/db/schema/identity.js';
import { auditLogs } from '../src/db/schema/security.js';
import { tenants } from '../src/db/schema/tenants.js';
import { departments, employees } from '../src/db/schema/workforce.js';
import { runMigrations, startTestDatabase } from './helpers/database.js';

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const departmentId = randomUUID();
const otherDepartmentId = randomUUID();
const authConfig = parseAuthConfig({ JWT_SECRET: randomBytes(32).toString('hex') });
const actor = (role: string, department: string | null, tenant = tenantId) => ({ id: randomUUID(), employeeId: randomUUID(), role, departmentId: department, tenantId: tenant });
const actors = {
  admin: actor('admin', null), manager: actor('sales_manager', departmentId),
  otherManager: actor('sales_manager', otherDepartmentId), rep: actor('sales_rep', departmentId),
  otherRep: actor('sales_rep', departmentId), viewer: actor('viewer', departmentId),
  foreignAdmin: actor('admin', null, otherTenantId),
};
type Actor = keyof typeof actors;
let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let client: ReturnType<typeof createDbClient>;
let app: ReturnType<typeof buildApp>;
let mock: ReturnType<typeof createMockBitrix>;
let service: ReturnType<typeof createApprovalsService>;

beforeAll(async () => {
  container = await startTestDatabase('approvals_test');
  ownerPool = new Pool({ connectionString: container.getConnectionUri() });
  const owner = drizzle(ownerPool);
  runMigrations(container);
  await owner.execute(sql`ALTER ROLE app_user PASSWORD 'approval-test-only-password'`);
  const url = new URL(container.getConnectionUri());
  url.username = 'app_user'; url.password = 'approval-test-only-password';
  client = createDbClient(url.toString());
  await owner.insert(tenants).values([{ id: tenantId, name: 'A' }, { id: otherTenantId, name: 'B' }]);
  await owner.insert(departments).values([{ id: departmentId, tenantId, name: 'Sales' }, { id: otherDepartmentId, tenantId, name: 'Other' }]);
  for (const actor of Object.values(actors)) {
    await owner.insert(users).values({ id: actor.id, tenantId: actor.tenantId, name: actor.role, email: `${actor.id}@example.invalid`, passwordHash: 'fixture-only' });
    await owner.insert(employees).values({ id: actor.employeeId, tenantId: actor.tenantId, userId: actor.id, departmentId: actor.departmentId, name: actor.role });
    const [role] = await owner.insert(roles).values({ tenantId: actor.tenantId, name: actor.role }).onConflictDoUpdate({ target: [roles.tenantId, roles.name], set: { name: actor.role } }).returning();
    if (!role) throw new Error('Role fixture missing');
    await owner.insert(userRoles).values({ tenantId: actor.tenantId, userId: actor.id, roleId: role.id });
    if (actor.role === 'viewer') continue;
    for (const code of ['tasks:create', 'tasks:read', 'contacts:read', 'approvals:read', 'approvals:decide', 'deals:read']) {
      const [permission] = await owner.insert(permissions).values({ tenantId: actor.tenantId, code, description: code }).onConflictDoUpdate({ target: [permissions.tenantId, permissions.code], set: { description: code } }).returning();
      if (!permission) throw new Error('Permission fixture missing');
      await owner.insert(rolePermissions).values({ tenantId: actor.tenantId, roleId: role.id, permissionId: permission.id }).onConflictDoNothing();
    }
  }
  for (const actor of [actors.rep, actors.otherManager, actors.foreignAdmin]) {
    const [contact] = await owner.insert(contacts).values({ tenantId: actor.tenantId, name: actor.id }).returning();
    await owner.insert(deals).values({ tenantId: actor.tenantId, title: actor.id, amount: '10', currency: 'USD', contactId: contact?.id, responsibleEmployeeId: actor.employeeId });
  }
  mock = createMockBitrix(client);
  service = createApprovalsService(client, mock);
  app = buildApp(parseConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), undefined, { authConfig, database: client, mockBitrix: mock });
  await app.ready();
}, 180000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try { await app?.close(); await client?.close(); await ownerPool?.end(); }
  finally { if (container) await container.stop(); }
}, 30000);

async function context(key: Actor = 'rep') {
  const actor = actors[key];
  const ctx = await client.withTenant({ tenant_id: actor.tenantId, user_id: actor.id }, (tx) => loadContext(tx, actor.tenantId, actor.id, randomUUID()));
  if (!ctx) throw new Error('Context fixture missing');
  return ctx;
}
function payload(assigneeEmployeeId = actors.rep.employeeId) {
  return { title: 'Call customer', description: 'Discuss renewal', assigneeEmployeeId, dueAt: '2027-01-10T10:00:00Z' };
}
async function propose(key: Actor = 'rep', data = payload()) {
  return service.createProposal(await context(key), { type: 'task.create', payload: data });
}
async function headers(key: Actor = 'rep') {
  const actor = actors[key];
  return { authorization: `Bearer ${await signAccessToken(authConfig, { tenantId: actor.tenantId, userId: actor.id, roles: [] })}` };
}
async function approve(id: string, key: Actor = 'rep') {
  return app.inject({ method: 'POST', url: `/approvals/${id}/approve`, headers: await headers(key) });
}
async function taskCount(id: string) { return (await drizzle(ownerPool).select().from(tasks).where(eq(tasks.id, id))).length; }
async function events(id: string) { return drizzle(ownerPool).select().from(auditLogs).where(eq(auditLogs.entityId, id)); }
function fields(data = payload()) { return { fields: { TITLE: data.title, DESCRIPTION: data.description, RESPONSIBLE_ID: data.assigneeEmployeeId, DEADLINE: data.dueAt } }; }

describe('task proposals and approval execution', () => {
  it('creates an audited proposal without creating a task, allowing independent identical proposals', async () => {
    const first = await propose();
    const second = await propose();
    expect(first).toMatchObject({ tenantId, userId: actors.rep.id, type: 'task.create', status: 'pending', attempts: 0 });
    expect(first.id).not.toBe(second.id);
    expect(await taskCount(first.id)).toBe(0);
    expect((await events(first.id)).map((event) => event.action)).toEqual(['approval.created']);
    expect((await approve(first.id)).statusCode).toBe(200);
    expect((await approve(second.id)).statusCode).toBe(200);
    expect(await taskCount(first.id)).toBe(1);
    expect(await taskCount(second.id)).toBe(1);
  });

  it('rejects injected identity, unsupported tools, invalid deadlines and out-of-scope assignees', async () => {
    const ctx = await context();
    await expect(service.createProposal(ctx, { type: 'task.create', payload: payload(), tenantId: otherTenantId })).rejects.toThrow(z.ZodError);
    await expect(service.createProposal(ctx, { type: 'deal.delete', payload: payload() })).rejects.toThrow(z.ZodError);
    await expect(service.createProposal(ctx, { type: 'task.create', payload: { ...payload(), dueAt: 'tomorrow' } })).rejects.toThrow(z.ZodError);
    await expect(propose('rep', payload(actors.otherRep.employeeId))).rejects.toMatchObject({ statusCode: 403 });
    await expect(propose('manager', payload(actors.otherManager.employeeId))).rejects.toMatchObject({ statusCode: 403 });
    await expect(propose('admin', payload(actors.foreignAdmin.employeeId))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('double approval creates one task and audits every state transition exactly once', async () => {
    const action = await propose();
    const first = await approve(action.id);
    const second = await approve(action.id);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(first.json()).toMatchObject({ id: action.id, status: 'executed', attempts: 1 });
    expect(await taskCount(action.id)).toBe(1);
    const transitions = (await events(action.id)).filter((event) => event.details['to'] !== undefined);
    expect(transitions.map((event) => event.details['to']).sort()).toEqual(['pending', 'approved', 'executing', 'executed'].sort());
    expect(transitions.every((event) => event.requestId !== null)).toBe(true);
  });

  it('concurrent requester, manager and admin approvals execute once', async () => {
    const action = await propose();
    const responses = await Promise.all([approve(action.id), approve(action.id, 'manager'), approve(action.id, 'admin')]);
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(await taskCount(action.id)).toBe(1);
    expect((await events(action.id)).filter((event) => event.action === 'approval.executing')).toHaveLength(1);
    const [stored] = await drizzle(ownerPool).select().from(pendingActions).where(eq(pendingActions.id, action.id));
    expect(stored).toMatchObject({ status: 'executed', attempts: 1 });
  });

  it.each([503, 504] as const)('retries HTTP %s failures three total times and audits failure', async (status) => {
    const calls = vi.spyOn(mock, 'addTask').mockRejectedValue(new HttpError(status, 'Service unavailable'));
    const action = await propose();
    const result = await service.approve(await context(), action.id);
    expect(result).toMatchObject({ status: 'failed', attempts: 3 });
    expect(calls).toHaveBeenCalledTimes(3);
    expect(await service.approve(await context(), action.id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(calls).toHaveBeenCalledTimes(3);
    expect(await taskCount(action.id)).toBe(0);
    expect((await events(action.id)).some((event) => event.details['to'] === 'failed')).toBe(true);
  });

  it('does not retry 4xx or unexpected internal errors', async () => {
    for (const failure of [new HttpError(422, 'Request rejected'), new Error('sensitive internal detail')]) {
      const calls = vi.spyOn(mock, 'addTask').mockRejectedValueOnce(failure);
      const action = await propose();
      const result = await service.approve(await context(), action.id);
      expect(result).toMatchObject({ status: 'failed', attempts: 1 });
      expect(calls).toHaveBeenCalledTimes(1);
      expect(await taskCount(action.id)).toBe(0);
      expect(JSON.stringify(await events(action.id))).not.toContain('sensitive internal detail');
      calls.mockRestore();
    }
  });

  it('recovers from a transient 5xx and from a timeout after the task was committed without duplication', async () => {
    for (const afterWrite of [false, true]) {
      const addTask = mock.addTask;
      const calls = vi.spyOn(mock, 'addTask').mockImplementationOnce(async (...args) => {
        if (afterWrite) await addTask(...args);
        throw new HttpError(afterWrite ? 504 : 503, 'Service unavailable');
      });
      const action = await propose();
      expect(await service.approve(await context(), action.id)).toMatchObject({ status: 'executed', attempts: 2 });
      expect(calls).toHaveBeenCalledTimes(2);
      expect(await taskCount(action.id)).toBe(1);
      expect((await events(action.id)).filter((event) => event.action === 'task.created')).toHaveLength(1);
      calls.mockRestore();
    }
  });

  it('expires an action before approval and audits that transition', async () => {
    const action = await propose();
    await drizzle(ownerPool).update(pendingActions).set({ expiresAt: new Date(1) }).where(eq(pendingActions.id, action.id));
    expect((await approve(action.id)).statusCode).toBe(410);
    expect(await taskCount(action.id)).toBe(0);
    expect((await events(action.id)).filter((event) => event.details['to'] === 'expired')).toHaveLength(1);
    expect((await approve(action.id)).statusCode).toBe(410);
    expect((await events(action.id)).filter((event) => event.details['to'] === 'expired')).toHaveLength(1);
  });

  it('rejects an action without executing and cannot later approve it', async () => {
    const action = await propose();
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: 'POST', url: `/approvals/${action.id}/reject`, headers: await headers('manager') });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'rejected' });
    }
    expect((await approve(action.id)).statusCode).toBe(409);
    expect(await taskCount(action.id)).toBe(0);
    expect((await events(action.id)).filter((event) => event.details['to'] === 'rejected')).toHaveLength(1);
  });

  it('serializes conflicting approve/reject decisions without accepting both', async () => {
    const action = await propose();
    const responses = await Promise.all([
      approve(action.id),
      app.inject({ method: 'POST', url: `/approvals/${action.id}/reject`, headers: await headers('manager') }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const [stored] = await drizzle(ownerPool).select().from(pendingActions).where(eq(pendingActions.id, action.id));
    expect(await taskCount(action.id)).toBe(stored?.status === 'executed' ? 1 : 0);
    const decisions = (await events(action.id)).filter((event) => event.action === 'approval.approved' || event.action === 'approval.rejected');
    expect(decisions).toHaveLength(1);
  });

  it('denies unrelated users, other-department managers and other tenants', async () => {
    const action = await propose();
    for (const key of ['otherRep', 'otherManager', 'foreignAdmin'] as const) {
      expect((await approve(action.id, key)).statusCode).toBe(key === 'foreignAdmin' ? 404 : 403);
      const response = await app.inject({ method: 'POST', url: `/approvals/${action.id}/reject`, headers: await headers(key) });
      expect(response.statusCode).toBe(key === 'foreignAdmin' ? 404 : 403);
    }
    expect(await taskCount(action.id)).toBe(0);
    expect((await events(action.id))).toHaveLength(1);
  });

  it('lists only proposals visible to the caller and validates pagination/tenant filters', async () => {
    const own = await propose();
    const sameDepartment = await propose('otherRep', payload(actors.otherRep.employeeId));
    const otherDepartment = await propose('otherManager', payload(actors.otherManager.employeeId));
    const foreign = await propose('foreignAdmin', payload(actors.foreignAdmin.employeeId));
    const ids = async (key: Actor) => {
      const response = await app.inject({ url: '/approvals?limit=100', headers: await headers(key) });
      expect(response.statusCode).toBe(200);
      return z.array(z.object({ id: z.uuid() })).parse(response.json()).map((action) => action.id);
    };
    expect(await ids('rep')).toContain(own.id);
    expect(await ids('rep')).not.toContain(sameDepartment.id);
    expect(await ids('manager')).toContain(sameDepartment.id);
    expect(await ids('manager')).not.toContain(otherDepartment.id);
    expect(await ids('admin')).toContain(otherDepartment.id);
    expect(await ids('admin')).not.toContain(foreign.id);
    expect((await app.inject({ url: `/approvals?tenantId=${otherTenantId}`, headers: await headers('admin') })).statusCode).toBe(400);
  });

  it('revalidates requester permission before approval and again immediately before task insertion', async () => {
    const owner = drizzle(ownerPool);
    const [role] = await owner.select().from(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.name, 'sales_rep')));
    const [permission] = await owner.select().from(permissions).where(and(eq(permissions.tenantId, tenantId), eq(permissions.code, 'tasks:create')));
    if (!role || !permission) throw new Error('Missing permission fixture');
    const revoke = () => owner.delete(rolePermissions).where(and(eq(rolePermissions.roleId, role.id), eq(rolePermissions.permissionId, permission.id)));
    const restore = () => owner.insert(rolePermissions).values({ tenantId, roleId: role.id, permissionId: permission.id }).onConflictDoNothing();
    const action = await propose();
    await revoke();
    try { expect((await approve(action.id, 'manager')).statusCode).toBe(403); }
    finally { await restore(); }
    const addTask = mock.addTask;
    vi.spyOn(mock, 'addTask').mockImplementationOnce(async (...args) => {
      await revoke();
      try { return await addTask(...args); } finally { await restore(); }
    });
    expect(await service.approve(await context('manager'), action.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await taskCount(action.id)).toBe(0);
  });

  it('revalidates department changes and rejects viewers even with accidental permissions', async () => {
    const owner = drizzle(ownerPool);
    const action = await propose('manager');
    await owner.update(employees).set({ departmentId: otherDepartmentId }).where(eq(employees.id, actors.rep.employeeId));
    try { expect((await approve(action.id, 'manager')).statusCode).toBe(403); }
    finally { await owner.update(employees).set({ departmentId }).where(eq(employees.id, actors.rep.employeeId)); }
    const [role] = await owner.select().from(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.name, 'viewer')));
    if (!role) throw new Error('Missing viewer');
    const perms = await owner.select().from(permissions).where(eq(permissions.tenantId, tenantId));
    await owner.insert(rolePermissions).values(perms.map((permission) => ({ tenantId, roleId: role.id, permissionId: permission.id })));
    try {
      expect((await approve(action.id, 'viewer')).statusCode).toBe(403);
      await expect(propose('viewer', payload(actors.viewer.employeeId))).rejects.toMatchObject({ statusCode: 403 });
      expect((await app.inject({ url: '/approvals', headers: await headers('viewer') })).statusCode).toBe(403);
    } finally { await owner.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id)); }
  });

  it('does not let a manager approve an admin proposal targeting another department', async () => {
    const owner = drizzle(ownerPool);
    await owner.update(employees).set({ departmentId }).where(eq(employees.id, actors.admin.employeeId));
    try {
      const action = await propose('admin', payload(actors.otherManager.employeeId));
      expect((await approve(action.id, 'manager')).statusCode).toBe(403);
      expect(await taskCount(action.id)).toBe(0);
      expect((await approve(action.id, 'admin')).statusCode).toBe(200);
    } finally {
      await owner.update(employees).set({ departmentId: null }).where(eq(employees.id, actors.admin.employeeId));
    }
  });

  it('revalidates the approver task permission immediately before insertion', async () => {
    const owner = drizzle(ownerPool);
    const [role] = await owner.select().from(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.name, 'sales_manager')));
    const [permission] = await owner.select().from(permissions).where(and(eq(permissions.tenantId, tenantId), eq(permissions.code, 'tasks:create')));
    if (!role || !permission) throw new Error('Missing manager permission');
    const addTask = mock.addTask;
    vi.spyOn(mock, 'addTask').mockImplementationOnce(async (...args) => {
      await owner.delete(rolePermissions).where(and(eq(rolePermissions.roleId, role.id), eq(rolePermissions.permissionId, permission.id)));
      try { return await addTask(...args); }
      finally { await owner.insert(rolePermissions).values({ tenantId, roleId: role.id, permissionId: permission.id }); }
    });
    const action = await propose();
    expect(await service.approve(await context('manager'), action.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await taskCount(action.id)).toBe(0);
  });

  it('rolls the approval transition back when its audit insert fails', async () => {
    const action = await propose();
    const owner = drizzle(ownerPool);
    await owner.execute(sql`CREATE FUNCTION fail_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'approval.approved' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await owner.execute(sql`CREATE TRIGGER fail_approval_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_approval_audit()`);
    try {
      expect((await approve(action.id)).statusCode).toBe(500);
      const [stored] = await owner.select().from(pendingActions).where(eq(pendingActions.id, action.id));
      expect(stored?.status).toBe('pending');
      expect(await taskCount(action.id)).toBe(0);
      expect(await events(action.id)).toHaveLength(1);
    } finally {
      await owner.execute(sql`DROP TRIGGER fail_approval_audit ON audit_logs`);
      await owner.execute(sql`DROP FUNCTION fail_approval_audit()`);
    }
  });

  it('does not commit a task if task auditing fails', async () => {
    const action = await propose();
    const owner = drizzle(ownerPool);
    await owner.execute(sql`CREATE FUNCTION fail_task_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'task.created' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await owner.execute(sql`CREATE TRIGGER fail_task_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_task_audit()`);
    try {
      expect(await service.approve(await context(), action.id)).toMatchObject({ status: 'failed', attempts: 1 });
      expect(await taskCount(action.id)).toBe(0);
      expect((await events(action.id)).filter((event) => event.action === 'task.created')).toHaveLength(0);
    } finally {
      await owner.execute(sql`DROP TRIGGER fail_task_audit ON audit_logs`);
      await owner.execute(sql`DROP FUNCTION fail_task_audit()`);
    }
  });

  it('provisions tenant-local approval permissions for existing allowed roles idempotently', async () => {
    const owner = drizzle(ownerPool);
    const tenant = randomUUID();
    await owner.insert(tenants).values({ id: tenant, name: 'Permission upgrade' });
    await owner.insert(roles).values(['admin', 'sales_manager', 'sales_rep', 'viewer'].map((name) => ({ tenantId: tenant, name })));
    const migration = readFileSync(new URL('../drizzle/0005_approval_permissions.sql', import.meta.url), 'utf8');
    // Replay the committed data migration against roles created after the initial migration run.
    await ownerPool.query(migration);
    await ownerPool.query(migration);
    const rows = await owner.select({ role: roles.name, permission: permissions.code }).from(roles)
      .leftJoin(rolePermissions, and(eq(rolePermissions.tenantId, roles.tenantId), eq(rolePermissions.roleId, roles.id)))
      .leftJoin(permissions, and(eq(permissions.tenantId, rolePermissions.tenantId), eq(permissions.id, rolePermissions.permissionId)))
      .where(eq(roles.tenantId, tenant));
    expect(rows.filter((row) => row.role === 'viewer')).toEqual([{ role: 'viewer', permission: null }]);
    for (const role of ['admin', 'sales_manager', 'sales_rep']) {
      expect(rows.filter((row) => row.role === role).map((row) => row.permission).sort()).toEqual(['approvals:decide', 'approvals:read', 'contacts:read', 'tasks:create', 'tasks:read']);
    }
  });
});

describe('in-app mock Bitrix operations', () => {
  it('requires approval, enforces the immutable payload, and returns an existing task on repeat', async () => {
    const action = await propose();
    const request = { method: 'POST' as const, url: '/rest/tasks.task.add', headers: { ...await headers(), 'idempotency-key': action.id }, payload: fields() };
    expect((await app.inject({ ...request, headers: { 'idempotency-key': action.id } })).statusCode).toBe(401);
    expect((await app.inject(request)).statusCode).toBe(409);
    expect((await approve(action.id)).statusCode).toBe(200);
    const result = await app.inject(request);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ result: { task: { id: action.id, title: payload().title } } });
    expect(await taskCount(action.id)).toBe(1);
    expect((await app.inject({ ...request, payload: fields({ ...payload(), title: 'Changed after approval' }) })).statusCode).toBe(409);
    expect((await app.inject({ ...request, headers: { ...await headers('foreignAdmin'), 'idempotency-key': action.id } })).statusCode).toBe(404);
  });

  it('scopes deal/contact lists and task lookup to tenant and department/assignee', async () => {
    for (const method of ['crm.deal.list', 'crm.contact.list']) {
      const list = async (key: Actor) => {
        const response = await app.inject({ method: 'POST', url: `/rest/${method}`, headers: await headers(key), payload: {} });
        expect(response.statusCode).toBe(200);
        return z.object({ result: z.array(z.object({ ID: z.uuid() })) }).parse(response.json()).result;
      };
      expect(await list('rep')).toHaveLength(1);
      expect(await list('manager')).toHaveLength(1);
      expect(await list('admin')).toHaveLength(2);
      expect(await list('foreignAdmin')).toHaveLength(1);
      expect((await app.inject({ method: 'POST', url: `/rest/${method}`, headers: await headers('viewer'), payload: {} })).statusCode).toBe(403);
    }
    const action = await propose();
    await approve(action.id);
    for (const key of ['rep', 'manager', 'otherRep', 'otherManager', 'foreignAdmin'] as const) {
      const response = await app.inject({ method: 'POST', url: '/rest/tasks.task.get', headers: await headers(key), payload: { taskId: action.id } });
      expect(response.statusCode).toBe(key === 'rep' || key === 'manager' ? 200 : 404);
    }
  });
});
