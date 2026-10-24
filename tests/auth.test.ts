import { randomBytes, randomUUID } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { hash } from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { SignJWT, decodeJwt } from 'jose';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { parseAuthConfig } from '../src/auth/config.js';
import { hashRefreshToken } from '../src/auth/service.js';
import { can, recordScope, scopeFilter } from '../src/auth/rbac.js';
import { writeAudit } from '../src/observability/audit.js';
import { createDbClient } from '../src/db/client.js';
import { deals } from '../src/db/schema/crm.js';
import { permissions, rolePermissions, roles, userRoles, users } from '../src/db/schema/identity.js';
import { auditLogs, refreshTokens } from '../src/db/schema/security.js';
import { tenants } from '../src/db/schema/tenants.js';
import { departments, employees } from '../src/db/schema/workforce.js';
import { runMigrations, startTestDatabase } from './helpers/database.js';

const authConfig = parseAuthConfig({ JWT_SECRET: randomBytes(32).toString('hex'), REFRESH_TOKEN_PEPPER: randomBytes(32).toString('hex') });
const tenantA = randomUUID();
const tenantB = randomUUID();
const password = randomBytes(24).toString('base64url');
const fixtures = ['admin', 'sales_manager', 'sales_rep', 'viewer'].map((role) => ({
  role, id: randomUUID(), employeeId: randomUUID(), roleId: randomUUID(),
}));
const departmentId = randomUUID();
const otherDepartmentId = randomUUID();
const otherEmployeeId = randomUUID();
const tenantBUser = randomUUID();
const tokenSchema = z.object({ accessToken: z.string(), refreshToken: z.string(), expiresIn: z.literal(900) });
let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let client: ReturnType<typeof createDbClient>;
let app: ReturnType<typeof buildApp>;
const logs: string[] = [];

beforeAll(async () => {
  container = await startTestDatabase('auth_test');
  ownerPool = new Pool({ connectionString: container.getConnectionUri() });
  const owner = drizzle(ownerPool);
  runMigrations(container);
  await owner.execute(sql`ALTER ROLE app_user PASSWORD 'auth-test-only-password'`);
  const url = new URL(container.getConnectionUri());
  url.username = 'app_user';
  url.password = 'auth-test-only-password';
  client = createDbClient(url.toString());
  await owner.insert(tenants).values([{ id: tenantA, name: 'A' }, { id: tenantB, name: 'B' }]);
  await owner.insert(departments).values([
    { id: departmentId, tenantId: tenantA, name: 'Sales' },
    { id: otherDepartmentId, tenantId: tenantA, name: 'Other' },
  ]);
  const passwordHash = await hash(password);
  const codes = ['deals:read', 'deals:aggregate', 'departments:read', 'audit_logs:read'];
  for (const fixture of fixtures) {
    await owner.insert(users).values({ id: fixture.id, tenantId: tenantA, email: `${fixture.role}@example.invalid`, name: fixture.role, passwordHash });
    await owner.insert(roles).values({ id: fixture.roleId, tenantId: tenantA, name: fixture.role });
    await owner.insert(userRoles).values({ tenantId: tenantA, userId: fixture.id, roleId: fixture.roleId });
    await owner.insert(employees).values({ id: fixture.employeeId, tenantId: tenantA, name: fixture.role, userId: fixture.id, departmentId });
  }
  for (const code of codes) {
    const permissionId = randomUUID();
    await owner.insert(permissions).values({ id: permissionId, tenantId: tenantA, code, description: code });
    for (const fixture of fixtures) {
      if (fixture.role === 'admin' || code === 'deals:aggregate' || (code === 'deals:read' && fixture.role !== 'viewer') || (code === 'departments:read' && fixture.role === 'sales_manager')) {
        await owner.insert(rolePermissions).values({ tenantId: tenantA, roleId: fixture.roleId, permissionId });
      }
    }
  }
  await owner.insert(users).values({ id: tenantBUser, tenantId: tenantB, name: 'B', email: 'admin@example.invalid', passwordHash: await hash(randomBytes(24).toString('hex')) });
  await owner.insert(employees).values({ id: otherEmployeeId, tenantId: tenantA, name: 'Other', departmentId: otherDepartmentId });
  await owner.insert(deals).values([
    ...fixtures.map((f) => ({ tenantId: tenantA, title: f.role, amount: '1.00', currency: 'USD', responsibleEmployeeId: f.employeeId })),
    { tenantId: tenantA, title: 'Other', amount: '2.00', currency: 'USD', responsibleEmployeeId: otherEmployeeId },
    { tenantId: tenantB, title: 'B', amount: '3.00', currency: 'USD' },
  ]);
  await owner.insert(auditLogs).values({ tenantId: tenantB, actorUserId: tenantBUser, action: 'secret-B', entityType: 'user' });
  app = buildApp(parseConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' }), { write: (line: string) => { logs.push(line); } }, { authConfig, database: client });
  app.get('/test/manager', { preHandler: app.authenticate }, (request, reply) => {
    if (!can(request.context, 'departments:read')) return reply.code(403).send({ error: 'Forbidden' });
    return { context: request.context };
  });
  app.get('/test/deals', { preHandler: app.authenticate }, async (request, reply) => {
    if (!can(request.context, 'deals:read')) return reply.code(403).send({ error: 'Forbidden' });
    const ctx = request.context;
    return client.withTenant({ tenant_id: ctx.tenantId, user_id: ctx.userId }, (tx) =>
      tx.select({ title: deals.title }).from(deals).where(scopeFilter(ctx, 'rows', { tenantId: deals.tenantId, employeeId: deals.responsibleEmployeeId })));
  });
  await app.ready();
}, 180000);

afterAll(async () => {
  try { await app?.close(); await client?.close(); await ownerPool?.end(); }
  finally { if (container) await container.stop(); }
}, 30000);

let loginIp = 0;
async function login(role = 'admin', tenantId = tenantA) {
  const response = await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: `10.0.0.${++loginIp}`, payload: { tenantId, email: `${role}@example.invalid`, password } });
  expect(response.statusCode, response.body).toBe(200);
  return tokenSchema.parse(response.json());
}
// Each call gets its own simulated client IP, like login() above, so the 5/min-per-IP refresh
// limiter does not make unrelated test cases collide on the default inject address.
let refreshIp = 0;
function refresh(refreshToken: string, tenantId = tenantA) {
  return app.inject({ method: 'POST', url: '/auth/refresh', remoteAddress: `10.0.2.${++refreshIp}`, payload: { tenantId, refreshToken } });
}
function headers(accessToken: string) { return { authorization: `Bearer ${accessToken}` }; }

describe('authentication and sessions', () => {
  it('verifies Argon2 credentials and issues a 15-minute JWT with DB identity and roles', async () => {
    const tokens = await login();
    const claims = decodeJwt(tokens.accessToken);
    expect(claims).toMatchObject({ tenantId: tenantA, userId: fixtures[0]?.id, roles: ['admin'], iss: authConfig.JWT_ISSUER, aud: authConfig.JWT_AUDIENCE });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(900);
    expect(claims).not.toHaveProperty('permissions');
    expect(claims).not.toHaveProperty('employeeId');
    expect(claims).not.toHaveProperty('requestId');
    const rows = await drizzle(ownerPool).select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashRefreshToken(authConfig, tokens.refreshToken)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(tokens.refreshToken);
    expect(rows[0]?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 7 * 86400000);
    const response = await app.inject({ url: '/audit-logs', headers: headers(tokens.accessToken) });
    expect(response.statusCode).toBe(200);
  });

  it.each(['wrong-password', 'unknown-user', 'unknown-tenant'])('returns the same generic error for %s', async (kind) => {
    const response = await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: `10.0.1.${++loginIp}`, payload: {
      tenantId: kind === 'unknown-tenant' ? randomUUID() : tenantA,
      email: kind === 'unknown-user' ? 'missing@example.invalid' : 'admin@example.invalid', password: kind === 'wrong-password' ? 'incorrect' : password,
    } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid credentials' });
  });

  it('rejects malformed bodies and supplied identity/role fields', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { tenantId: tenantA, email: 'admin@example.invalid', password, roles: ['admin'], userId: randomUUID() } });
    expect(response.statusCode).toBe(400);
  });

  it('does not authenticate another tenant with tenant A credentials for the same email', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { tenantId: tenantB, email: 'admin@example.invalid', password } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid credentials' });
  });

  it('rate-limits login to five attempts per minute and ignores spoofed forwarded headers', async () => {
    for (let i = 0; i < 6; i++) {
      const response = await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: '192.0.2.10', headers: { 'x-forwarded-for': `198.51.100.${i}` }, payload: { tenantId: tenantA, email: 'admin@example.invalid', password: 'bad' } });
      expect(response.statusCode).toBe(i === 5 ? 429 : 401);
    }
  });

  it('rejects missing, expired, tampered, wrong-audience and wrong-algorithm tokens', async () => {
    expect((await app.inject({ url: '/audit-logs' })).statusCode).toBe(401);
    const tokens = await login();
    const claims = decodeJwt(tokens.accessToken);
    for (const options of [{ exp: 1 }, { aud: 'other' }, { alg: 'HS384' }]) {
      const token = await new SignJWT({ tenantId: claims.tenantId, userId: claims.userId, roles: claims.roles })
        .setProtectedHeader({ alg: options.alg ?? 'HS256', typ: 'JWT' }).setIssuedAt()
        .setExpirationTime(options.exp ?? '15m').setIssuer(authConfig.JWT_ISSUER).setAudience(options.aud ?? authConfig.JWT_AUDIENCE)
        .sign(new TextEncoder().encode(authConfig.JWT_SECRET));
      expect((await app.inject({ url: '/audit-logs', headers: headers(token) })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: '/audit-logs', headers: headers(`${tokens.accessToken}x`) })).statusCode).toBe(401);
  });

  it('rotates refresh tokens and preserves absolute family expiry', async () => {
    const first = await login();
    const secondResponse = await refresh(first.refreshToken);
    expect(secondResponse.statusCode).toBe(200);
    const second = tokenSchema.parse(secondResponse.json());
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const rows = await drizzle(ownerPool).select().from(refreshTokens).where(eq(refreshTokens.userId, fixtures[0]?.id ?? ''));
    const original = rows.find((row) => row.tokenHash === hashRefreshToken(authConfig, first.refreshToken));
    const rotated = rows.find((row) => row.tokenHash === hashRefreshToken(authConfig, second.refreshToken));
    expect(original?.usedAt).toBeInstanceOf(Date);
    expect(rotated?.familyId).toBe(original?.familyId);
    expect(rotated?.expiresAt).toEqual(original?.expiresAt);
  });

  it('commits whole-family revocation when an already-rotated token is reused', async () => {
    const first = await login();
    const second = tokenSchema.parse((await refresh(first.refreshToken)).json());
    const third = tokenSchema.parse((await refresh(second.refreshToken)).json());
    expect((await refresh(first.refreshToken)).statusCode).toBe(401);
    expect((await refresh(third.refreshToken)).statusCode).toBe(401);
    const audit = await drizzle(ownerPool).select().from(auditLogs).where(eq(auditLogs.action, 'auth.refresh_reuse'));
    expect(audit.length).toBeGreaterThan(0);
    const independent = await login();
    expect((await refresh(independent.refreshToken)).statusCode).toBe(200);
  });

  it('serializes concurrent refreshes and revokes the winner after reuse is detected', async () => {
    const first = await login();
    const responses = await Promise.all([refresh(first.refreshToken), refresh(first.refreshToken)]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const winner = tokenSchema.parse(responses.find((r) => r.statusCode === 200)?.json());
    expect((await refresh(winner.refreshToken)).statusCode).toBe(401);
  });

  it('rejects unknown, expired, and cross-tenant refresh tokens', async () => {
    const tokens = await login();
    expect((await refresh(tokens.refreshToken, tenantB)).statusCode).toBe(401);
    expect((await refresh(randomBytes(32).toString('base64url'))).statusCode).toBe(401);
    await drizzle(ownerPool).update(refreshTokens).set({ expiresAt: new Date(1) }).where(eq(refreshTokens.tokenHash, hashRefreshToken(authConfig, tokens.refreshToken)));
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(401);
  });

  it('logs out the family, is idempotent, and retains the approved access-token lifetime', async () => {
    const tokens = await login();
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: 'POST', url: '/auth/logout', payload: { tenantId: tenantA, refreshToken: tokens.refreshToken } });
      expect(response.statusCode).toBe(204);
    }
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(401);
    expect((await app.inject({ url: '/audit-logs', headers: headers(tokens.accessToken) })).statusCode).toBe(200);
  });

  it('logout with a rotated ancestor revokes descendants; a wrong tenant cannot revoke them', async () => {
    const first = await login();
    const second = tokenSchema.parse((await refresh(first.refreshToken)).json());
    await app.inject({ method: 'POST', url: '/auth/logout', payload: { tenantId: tenantB, refreshToken: first.refreshToken } });
    const thirdResponse = await refresh(second.refreshToken);
    expect(thirdResponse.statusCode).toBe(200);
    const third = tokenSchema.parse(thirdResponse.json());
    await app.inject({ method: 'POST', url: '/auth/logout', payload: { tenantId: tenantA, refreshToken: first.refreshToken } });
    expect((await refresh(third.refreshToken)).statusCode).toBe(401);
  });

  it('does not log credentials or bearer/refresh tokens', async () => {
    const tokens = await login();
    await app.inject({ url: '/audit-logs', headers: headers(tokens.accessToken) });
    await refresh(tokens.refreshToken);
    const output = logs.join('\n');
    expect(output).not.toContain(password);
    expect(output).not.toContain(tokens.accessToken);
    expect(output).not.toContain(tokens.refreshToken);
  });
});

describe('request context, RBAC and audit', () => {
  it('builds context from current DB memberships and denies a rep the manager-only endpoint', async () => {
    const rep = await login('sales_rep');
    expect((await app.inject({ url: '/test/manager', headers: headers(rep.accessToken) })).statusCode).toBe(403);
    const manager = await login('sales_manager');
    const response = await app.inject({ url: '/test/manager', headers: { ...headers(manager.accessToken), 'x-request-id': 'untrusted', 'x-tenant-id': tenantB } });
    const body = z.object({ context: z.object({ tenantId: z.uuid(), userId: z.uuid(), employeeId: z.uuid(), departmentId: z.uuid(), roles: z.array(z.string()), permissions: z.array(z.string()), requestId: z.uuid() }) }).parse(response.json());
    expect(body.context).toMatchObject({ tenantId: tenantA, userId: fixtures[1]?.id, employeeId: fixtures[1]?.employeeId, departmentId, roles: ['sales_manager'] });
    expect(body.context.requestId).toBe(response.headers['x-request-id']);
  });

  it('denies viewer row reads even if accidentally granted deals:read', async () => {
    const fixture = fixtures[3];
    if (!fixture) throw new Error('Missing viewer fixture');
    const owner = drizzle(ownerPool);
    const [permission] = await owner.select().from(permissions).where(eq(permissions.code, 'deals:read'));
    if (!permission) throw new Error('Missing permission');
    await owner.insert(rolePermissions).values({ tenantId: tenantA, roleId: fixture.roleId, permissionId: permission.id });
    const viewer = await login('viewer');
    expect((await app.inject({ url: '/test/deals', headers: headers(viewer.accessToken) })).statusCode).toBe(403);
    expect((await app.inject({ url: '/audit-logs', headers: headers(viewer.accessToken) })).statusCode).toBe(403);
  });

  it.each([{ role: 'admin', count: 5 }, { role: 'sales_manager', count: 4 }, { role: 'sales_rep', count: 1 }])('applies $role record scope to actual deal queries', async ({ role, count }) => {
    const tokens = await login(role);
    const response = await app.inject({ url: '/test/deals', headers: headers(tokens.accessToken) });
    expect(response.statusCode).toBe(200);
    expect(z.array(z.object({ title: z.string() })).parse(response.json())).toHaveLength(count);
  });

  it('reloads permissions instead of authorizing stale JWT roles', async () => {
    const tokens = await login('sales_manager');
    const fixture = fixtures[1];
    if (!fixture) throw new Error('Missing fixture');
    const owner = drizzle(ownerPool);
    await owner.delete(userRoles).where(eq(userRoles.userId, fixture.id));
    expect((await app.inject({ url: '/test/manager', headers: headers(tokens.accessToken) })).statusCode).toBe(403);
    await owner.insert(userRoles).values({ tenantId: tenantA, userId: fixture.id, roleId: fixture.roleId });
  });

  it('never returns tenant B audit logs, rejects tenant filters, and validates pagination', async () => {
    const tokens = await login();
    const response = await app.inject({ url: '/audit-logs?limit=5&offset=0', headers: headers(tokens.accessToken) });
    expect(response.statusCode).toBe(200);
    const records = z.array(z.object({ tenantId: z.uuid(), action: z.string(), requestId: z.uuid().nullable() })).parse(response.json());
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.tenantId === tenantA && record.action !== 'secret-B')).toBe(true);
    for (const query of [`tenantId=${tenantB}`, 'limit=101', 'offset=-1']) {
      expect((await app.inject({ url: `/audit-logs?${query}`, headers: headers(tokens.accessToken) })).statusCode).toBe(400);
    }
  });

  it('commits audit and action together and rolls both back on error', async () => {
    const fixture = fixtures[0];
    if (!fixture) throw new Error('Missing fixture');
    const ctx = { tenantId: tenantA, userId: fixture.id, employeeId: fixture.employeeId, departmentId, roles: ['admin'], permissions: ['deals:read'], requestId: randomUUID() };
    const title = randomUUID();
    const action = async (fail: boolean) => client.withTenant({ tenant_id: tenantA, user_id: fixture.id }, async (tx) => {
      const [deal] = await tx.insert(deals).values({ tenantId: tenantA, title, amount: '1', currency: 'USD' }).returning();
      await writeAudit(tx, ctx, { action: 'deal.create', entityType: 'deal', entityId: deal?.id, metadata: { title } });
      if (fail) throw new Error('Rollback');
    });
    await expect(action(true)).rejects.toThrow('Rollback');
    expect(await drizzle(ownerPool).select().from(deals).where(eq(deals.title, title))).toHaveLength(0);
    expect(await drizzle(ownerPool).select().from(auditLogs).where(eq(auditLogs.requestId, ctx.requestId))).toHaveLength(0);
    await action(false);
    expect(await drizzle(ownerPool).select().from(deals).where(eq(deals.title, title))).toHaveLength(1);
    expect(await drizzle(ownerPool).select().from(auditLogs).where(eq(auditLogs.requestId, ctx.requestId))).toHaveLength(1);
  });

  it('rolls back the action when audit validation fails', async () => {
    const fixture = fixtures[0];
    if (!fixture) throw new Error('Missing fixture');
    const title = randomUUID();
    await expect(client.withTenant({ tenant_id: tenantA, user_id: fixture.id }, async (tx) => {
      await tx.insert(deals).values({ tenantId: tenantA, title, amount: '1', currency: 'USD' });
      await writeAudit(tx, { tenantId: tenantA, userId: fixture.id, requestId: randomUUID() }, {
        action: 'deal.create', entityType: 'deal', metadata: { invalid: Number.NaN },
      });
    })).rejects.toThrow(z.ZodError);
    expect(await drizzle(ownerPool).select().from(deals).where(eq(deals.title, title))).toHaveLength(0);
  });

  it('fails closed for unknown roles, missing scope links, and viewer row filters', () => {
    const base = { tenantId: tenantA, userId: randomUUID(), employeeId: null, departmentId: null, roles: ['sales_manager'], permissions: ['deals:read'], requestId: randomUUID() };
    expect(can(base, 'deals:read')).toBe(false);
    expect(recordScope({ ...base, roles: ['unknown'] }, 'rows')).toEqual({ kind: 'none' });
    expect(recordScope({ ...base, roles: ['viewer'] }, 'rows')).toEqual({ kind: 'none' });
    expect(recordScope({ ...base, roles: ['viewer'] }, 'aggregates')).toEqual({ kind: 'tenant' });
    expect(recordScope({ ...base, roles: ['viewer', 'admin'] }, 'rows')).toEqual({ kind: 'tenant' });
  });
});
