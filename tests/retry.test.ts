import { describe, expect, it, vi } from 'vitest';
import { computeBackoffMs, retry } from '../src/net/retry.js';

describe('computeBackoffMs', () => {
  it('doubles the base delay on each attempt', () => {
    expect(computeBackoffMs(0, { baseMs: 100 })).toBe(100);
    expect(computeBackoffMs(1, { baseMs: 100 })).toBe(200);
    expect(computeBackoffMs(2, { baseMs: 100 })).toBe(400);
  });

  it('caps the delay at maxMs before adding jitter', () => {
    expect(computeBackoffMs(10, { baseMs: 100, maxMs: 500 })).toBe(500);
  });

  it('adds bounded jitter on top of the exponential delay', () => {
    const samples = Array.from({ length: 50 }, () => computeBackoffMs(0, { baseMs: 100, jitterMs: 50 }));
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(100);
      expect(sample).toBeLessThanOrEqual(150);
    }
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  it('adds no jitter by default', () => {
    expect(computeBackoffMs(3, { baseMs: 50 })).toBe(400);
  });
});

describe('retry', () => {
  it('returns the first successful result without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn, { maxAttempts: 3, isRetryable: () => true, sleep: vi.fn() });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries only retryable errors up to maxAttempts total calls', async () => {
    const retryableError = new Error('retry me');
    const fn = vi.fn()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValueOnce('recovered');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await retry(fn, { maxAttempts: 3, isRetryable: () => true, sleep });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws immediately when the error is not retryable', async () => {
    const fatal = new Error('fatal');
    const fn = vi.fn().mockRejectedValue(fatal);
    const sleep = vi.fn();
    await expect(retry(fn, { maxAttempts: 5, isRetryable: () => false, sleep })).rejects.toBe(fatal);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws the last error once maxAttempts is exhausted', async () => {
    const error = new Error('still failing');
    const fn = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(retry(fn, { maxAttempts: 3, isRetryable: () => true, sleep })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('passes the computed delay to onRetry before sleeping', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce('ok');
    const onRetry = vi.fn();
    await retry(fn, { maxAttempts: 2, isRetryable: () => true, backoff: { baseMs: 10 }, sleep: vi.fn(), onRetry });
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 0, 10);
  });
});
