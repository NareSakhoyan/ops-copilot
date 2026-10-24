/**
 * Shared backoff/retry infrastructure for outbound calls. `computeBackoffMs` is deliberately a
 * pure function (no sleeping) so existing retry loops (embeddings, mock-task execution) can adopt
 * it for their delay calculation without changing their own control flow, attempt bookkeeping, or
 * audit side effects.
 */
export interface BackoffOptions {
  /** Base delay for attempt 0, doubled on each subsequent attempt. */
  baseMs?: number;
  /** Upper bound on the computed delay, before jitter. */
  maxMs?: number;
  /** Adds up to this many extra milliseconds, chosen pseudo-randomly, to avoid synchronized retries. */
  jitterMs?: number;
}

export function computeBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs = 1000, maxMs = Infinity, jitterMs = 0 } = options;
  const exponential = Math.min(baseMs * 2 ** attempt, maxMs);
  const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0;
  return Math.round(exponential + jitter);
}

export interface RetryOptions {
  maxAttempts: number;
  isRetryable: (error: unknown, attempt: number) => boolean;
  backoff?: BackoffOptions;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Runs `fn` with exponential backoff and jitter, retrying only errors `isRetryable` accepts.
 * Attempts are 0-indexed; `maxAttempts` is the total number of calls (including the first).
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, isRetryable, backoff, onRetry } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error: unknown) {
      if (attempt >= maxAttempts - 1 || !isRetryable(error, attempt)) throw error;
      const delayMs = computeBackoffMs(attempt, backoff);
      onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
