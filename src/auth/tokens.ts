import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { AuthConfig } from './config.js';

const accessClaimsSchema = z.object({
  tenantId: z.uuid(), userId: z.uuid(), roles: z.array(z.string()),
  iat: z.number().int(), exp: z.number().int(),
}).refine((claims) => claims.exp > claims.iat && claims.exp - claims.iat <= 900);

export async function signAccessToken(
  config: AuthConfig,
  identity: { tenantId: string; userId: string; roles: string[] },
): Promise<string> {
  return new SignJWT({ tenantId: identity.tenantId, userId: identity.userId, roles: identity.roles })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(config.JWT_ISSUER).setAudience(config.JWT_AUDIENCE)
    .setIssuedAt().setExpirationTime('15m').setJti(randomUUID())
    .sign(new TextEncoder().encode(config.JWT_SECRET));
}

export async function verifyAccessToken(config: AuthConfig, token: string) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(config.JWT_SECRET), {
    algorithms: ['HS256'], typ: 'JWT', issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE, maxTokenAge: '15m',
    requiredClaims: ['exp', 'iat', 'tenantId', 'userId', 'roles'],
  });
  return accessClaimsSchema.parse(payload);
}
