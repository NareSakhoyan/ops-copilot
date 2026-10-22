import { z } from 'zod';
import { loadEnvironment } from '../config.js';

const authConfigSchema = z.object({
  JWT_SECRET: z.string().min(32).max(512),
  JWT_ISSUER: z.string().min(1).default('ops-copilot'),
  JWT_AUDIENCE: z.string().min(1).default('ops-copilot-api'),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

export function parseAuthConfig(input: unknown): AuthConfig {
  return authConfigSchema.parse(input);
}

export function loadAuthConfig(): AuthConfig {
  return parseAuthConfig(loadEnvironment());
}
