import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = z.infer<typeof configSchema>;

export function parseConfig(input: unknown): AppConfig {
  return configSchema.parse(input);
}

export function loadConfig(
  envPath = resolve(process.cwd(), '.env'),
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  // Reading unconditionally ensures .env is required even when process variables exist.
  const fileEnvironment = parseEnv(readFileSync(envPath, 'utf8'));
  return parseConfig({ ...fileEnvironment, ...environment });
}
