import { readFileSync } from 'node:fs';

/**
 * Resolves `${name}` from either `${name}` directly or `${name}_FILE` (a path, e.g. a mounted
 * Docker secret under /run/secrets). When both are set, the file wins: it is the more secure
 * channel (not visible in `docker inspect`/process listing), so it should not be silently
 * shadowed by a stray plain-env value.
 */
export function resolveSecret(name: string, environment: NodeJS.ProcessEnv): string | undefined {
  const filePath = environment[`${name}_FILE`];
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf8').trim();
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      throw new Error(`Failed to read ${name}_FILE at "${filePath}": ${reason}`, { cause: error });
    }
  }
  return environment[name];
}

/** Returns a new environment object with each listed secret resolved via resolveSecret. */
export function resolveSecrets(environment: NodeJS.ProcessEnv, names: string[]): NodeJS.ProcessEnv {
  const resolved = { ...environment };
  for (const name of names) {
    const value = resolveSecret(name, environment);
    if (value === undefined) delete resolved[name];
    else resolved[name] = value;
  }
  return resolved;
}

// Known placeholder/example values that must never reach a production deployment.
const WEAK_VALUES = new Set([
  'password', 'postgres', 'changeme', 'change-me', 'change_me', 'secret', 'admin', 'admin123',
  'dev', 'development', 'test', '123456', 'postgrespassword', 'local-development-only',
  'local-app-development-only',
]);

export function isWeakSecretValue(value: string): boolean {
  return WEAK_VALUES.has(value.trim().toLowerCase());
}

/** Fails fast when a required secret is a known development/example placeholder in production. */
export function assertNotWeakInProduction(name: string, value: string, nodeEnv: string): void {
  if (nodeEnv === 'production' && isWeakSecretValue(value)) {
    throw new Error(`${name} must not use a known development/example value in production.`);
  }
}
