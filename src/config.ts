import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Fastify's trustProxy: set when behind a reverse proxy so req.ip (and rate-limit keying) use
  // the real client IP from X-Forwarded-For rather than the proxy's own address. "true"/"false",
  // or a specific proxy IP/CIDR string that Fastify understands. Defaults to not trusting any
  // proxy, which is correct for this single-host deployment's API port published directly.
  TRUST_PROXY: z.string().trim().optional().transform((value) => {
    if (value === undefined || value === '') return false;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1048576),
  // Comma-separated allowlist; empty/unset means no cross-origin access (this API has no browser
  // frontend by default).
  CORS_ALLOWED_ORIGINS: z.string().trim().optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_CHAT_MAX: z.coerce.number().int().positive().default(30),
  // Never honored when NODE_ENV=production (see src/app.ts); lets evals/CI reuse a cached token
  // without inheriting the per-user /chat limit across many sequential cases.
  RATE_LIMIT_TEST_BYPASS: z.coerce.boolean().default(false),
});

export type AppConfig = z.infer<typeof configSchema>;

export function parseConfig(input: unknown): AppConfig {
  return configSchema.parse(input);
}

export function loadEnvironment(
  envPath = resolve(process.cwd(), '.env'),
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Reading unconditionally ensures .env is required even when process variables exist.
  const fileEnvironment = parseEnv(readFileSync(envPath, 'utf8'));
  return { ...fileEnvironment, ...environment };
}

export function loadConfig(
  envPath = resolve(process.cwd(), '.env'),
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return parseConfig(loadEnvironment(envPath, environment));
}
