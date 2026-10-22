import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseAuthConfig } from '../src/auth/config.js';

describe('authentication configuration', () => {
  it('requires a signing secret and supplies issuer/audience defaults', () => {
    const secret = randomBytes(32).toString('hex');
    expect(parseAuthConfig({ JWT_SECRET: secret, OTHER: 'ignored' })).toEqual({ JWT_SECRET: secret, JWT_ISSUER: 'ops-copilot', JWT_AUDIENCE: 'ops-copilot-api' });
  });

  it.each([{}, { JWT_SECRET: '' }, { JWT_SECRET: 'short' }, { JWT_SECRET: 'x'.repeat(513) },
    { JWT_SECRET: 'x'.repeat(32), JWT_ISSUER: '' }, { JWT_SECRET: 'x'.repeat(32), JWT_AUDIENCE: '' },
  ])('rejects invalid settings: %j', (input) => {
    expect(() => parseAuthConfig(input)).toThrow(z.ZodError);
  });
});
