import { createHmac, randomBytes } from 'node:crypto';
import { hash, verify } from 'argon2';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TenantDatabase, TenantTransaction } from '../db/client.js';
import { users } from '../db/schema/identity.js';
import { refreshTokens } from '../db/schema/security.js';
import { writeAudit } from '../observability/audit.js';
import type { AuthConfig } from './config.js';
import { loadContext } from './context.js';
import type { RequestContext } from './context.js';
import { signAccessToken } from './tokens.js';

const loginSchema = z.object({
  tenantId: z.uuid(), email: z.email().max(254), password: z.string().min(1).max(1024),
}).strict();
const refreshSchema = z.object({ tenantId: z.uuid(), refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
type StoredToken = typeof refreshTokens.$inferSelect;

export class AuthenticationError extends Error {
  constructor(message = 'Invalid token') { super(message); }
}

// HMAC keyed by a dedicated pepper (never the JWT signing key) so a leaked database dump alone
// cannot be used to compute matching hashes for guessed/brute-forced tokens.
export function hashRefreshToken(config: AuthConfig, token: string): string {
  return createHmac('sha256', config.REFRESH_TOKEN_PEPPER).update(token).digest('hex');
}

export function createAuthService(database: TenantDatabase, config: AuthConfig) {
  let dummyHash: Promise<string> | undefined;

  async function issue(tx: TenantTransaction, ctx: RequestContext, family?: StoredToken) {
    const refreshToken = randomBytes(32).toString('base64url');
    await tx.insert(refreshTokens).values({
      tenantId: ctx.tenantId, userId: ctx.userId,
      tokenHash: hashRefreshToken(config, refreshToken),
      ...(family === undefined ? {} : { familyId: family.familyId }),
      expiresAt: family?.expiresAt ?? new Date(Date.now() + 7 * 86400000),
    });
    return { accessToken: await signAccessToken(config, ctx), refreshToken, expiresIn: 900 as const };
  }

  async function setActor(tx: TenantTransaction, userId: string): Promise<void> {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
  }

  async function revokeFamily(tx: TenantTransaction, token: StoredToken): Promise<void> {
    await tx.update(refreshTokens).set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.tenantId, token.tenantId), eq(refreshTokens.familyId, token.familyId)));
  }

  async function findLockedToken(tx: TenantTransaction, tenantId: string, rawToken: string): Promise<StoredToken | null> {
    const where = and(eq(refreshTokens.tenantId, tenantId), eq(refreshTokens.tokenHash, hashRefreshToken(config, rawToken)));
    const [candidate] = await tx.select().from(refreshTokens).where(where);
    if (!candidate) return null;
    // All refresh/logout operations lock the same family before changing any member.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${candidate.familyId}`}, 0))`);
    const [token] = await tx.select().from(refreshTokens).where(where).for('update');
    return token ?? null;
  }

  async function login(input: unknown, requestId: string) {
    const body = loginSchema.parse(input);
    const result = await database.withAuthTenant(body.tenantId, async (tx) => {
      const [user] = await tx.select().from(users).where(and(eq(users.tenantId, body.tenantId), eq(users.email, body.email)));
      const passwordHash = user?.passwordHash ?? await (dummyHash ??= hash(randomBytes(32).toString('hex')));
      let valid = false;
      try { valid = await verify(passwordHash, body.password); } catch { /* Invalid stored hashes fail closed. */ }
      if (!user || !valid) return null;
      await setActor(tx, user.id);
      const ctx = await loadContext(tx, body.tenantId, user.id, requestId);
      if (!ctx) return null;
      const tokens = await issue(tx, ctx);
      await writeAudit(tx, ctx, { action: 'auth.login', entityType: 'user', entityId: ctx.userId });
      return tokens;
    });
    if (!result) throw new AuthenticationError('Invalid credentials');
    return result;
  }

  async function refresh(input: unknown, requestId: string) {
    const body = refreshSchema.parse(input);
    const result = await database.withAuthTenant(body.tenantId, async (tx) => {
      const token = await findLockedToken(tx, body.tenantId, body.refreshToken);
      if (!token) return null;
      await setActor(tx, token.userId);
      const ctx = await loadContext(tx, token.tenantId, token.userId, requestId);
      if (!ctx) return null;
      if (token.usedAt !== null) {
        await revokeFamily(tx, token);
        await writeAudit(tx, ctx, { action: 'auth.refresh_reuse', entityType: 'refresh_token', entityId: token.id, metadata: { familyId: token.familyId } });
        return null;
      }
      if (token.revokedAt !== null || token.expiresAt.getTime() <= Date.now()) return null;
      await tx.update(refreshTokens).set({ usedAt: new Date() }).where(eq(refreshTokens.id, token.id));
      const tokens = await issue(tx, ctx, token);
      await writeAudit(tx, ctx, { action: 'auth.refresh', entityType: 'refresh_token', entityId: token.id });
      return tokens;
    });
    // Throw only after commit so reuse detection cannot roll back its revocation/audit.
    if (!result) throw new AuthenticationError();
    return result;
  }

  async function logout(input: unknown, requestId: string): Promise<void> {
    const body = refreshSchema.parse(input);
    await database.withAuthTenant(body.tenantId, async (tx) => {
      const token = await findLockedToken(tx, body.tenantId, body.refreshToken);
      if (!token || token.revokedAt !== null) return;
      await setActor(tx, token.userId);
      await revokeFamily(tx, token);
      await writeAudit(tx, { tenantId: token.tenantId, userId: token.userId, requestId }, {
        action: 'auth.logout', entityType: 'refresh_token', entityId: token.id,
      });
    });
  }

  return { login, refresh, logout };
}
