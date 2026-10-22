import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const directories: string[] = [];
const serverPath = fileURLToPath(new URL('../src/server.ts', import.meta.url));

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('server startup', () => {
  it.each([
    { name: 'missing .env', content: undefined, reason: 'ENOENT' },
    { name: 'invalid configuration', content: 'PORT=invalid\n', reason: 'ZodError' },
  ])('exits with an error for $name', ({ content, reason }) => {
    const directory = mkdtempSync(join(tmpdir(), 'ops-copilot-server-'));
    directories.push(directory);
    if (content !== undefined) {
      writeFileSync(join(directory, '.env'), content);
    }

    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), serverPath], {
      cwd: directory,
      env: {},
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const output: unknown = JSON.parse(result.stdout.trim());
    const log = z.object({ level: z.literal(60), msg: z.string(), err: z.object({ message: z.string() }) })
      .passthrough().parse(output);
    expect(log.msg).toBe('Application failed to initialize');
    expect(result.stdout).toContain(reason);
  });
});
