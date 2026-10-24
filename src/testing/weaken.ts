import { z } from 'zod';

const weakenSchema = z.enum(['rls', 'tenant_arg']);
export type EvalWeaken = z.infer<typeof weakenSchema>;

/**
 * Deliberately weakens one named security control so the eval security cases can be proven to
 * actually detect the regression they claim to catch, rather than passing vacuously. Hard-gated
 * off in production regardless of the env var; off everywhere else unless explicitly requested.
 */
export function getEvalWeaken(environment: NodeJS.ProcessEnv = process.env): EvalWeaken | undefined {
  if (environment.NODE_ENV === 'production') return undefined;
  const parsed = weakenSchema.safeParse(environment.EVAL_WEAKEN);
  return parsed.success ? parsed.data : undefined;
}
