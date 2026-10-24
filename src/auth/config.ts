import { z } from 'zod';
import { loadEnvironment } from '../config.js';
import { resolveSecrets } from '../secrets.js';

const authConfigSchema = z.object({
  JWT_SECRET: z.string().min(32).max(512),
  // Pepper for refresh-token hashing (HMAC-SHA256); kept separate from JWT_SECRET so rotating
  // one does not invalidate the other.
  REFRESH_TOKEN_PEPPER: z.string().min(32).max(512),
  JWT_ISSUER: z.string().min(1).default('ops-copilot'),
  JWT_AUDIENCE: z.string().min(1).default('ops-copilot-api'),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

export function parseAuthConfig(input: unknown): AuthConfig {
  return authConfigSchema.parse(input);
}

// Resolved from VAR or VAR_FILE (e.g. a mounted Docker secret); see src/secrets.ts. Both fields
// already require >= 32 characters unconditionally, which is strictly stronger than a
// production-only weak-value check, so no deny-list check is layered on top here (unlike
// db/config.ts's DATABASE_URL password, .env.example ships no placeholder for these fields).
const SECRET_NAMES = ['JWT_SECRET', 'REFRESH_TOKEN_PEPPER'];

export function loadAuthConfig(environment: NodeJS.ProcessEnv = loadEnvironment()): AuthConfig {
  return parseAuthConfig(resolveSecrets(environment, SECRET_NAMES));
}
