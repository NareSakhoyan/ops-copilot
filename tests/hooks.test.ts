import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('autofixes staged files, leaves unstaged files alone, and blocks lint errors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ops-copilot-hooks-'));
  directories.push(directory);
  mkdirSync(join(directory, '.husky'));
  mkdirSync(join(directory, 'src'));
  for (const path of ['package.json', '.gitignore', 'eslint.config.js', 'tsconfig.json', '.husky/pre-commit']) {
    copyFileSync(join(projectRoot, path), join(directory, path));
  }
  symlinkSync(join(projectRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');

  function run(command: string, args: string[]) {
    const result = spawnSync(command, args, {
      cwd: directory,
      env: {
        ...process.env,
        HUSKY: '1',
        XDG_CONFIG_HOME: join(directory, '.config'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'Hook Test',
        GIT_AUTHOR_EMAIL: 'hook-test@example.invalid',
        GIT_COMMITTER_NAME: 'Hook Test',
        GIT_COMMITTER_EMAIL: 'hook-test@example.invalid',
      },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  function succeed(command: string, args: string[]) {
    const result = run(command, args);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  }

  succeed('git', ['init', '--quiet']);
  writeFileSync(join(directory, 'src/config.ts'), 'export type AppConfig = { PORT: number };\n');
  writeFileSync(join(directory, 'src/sample.ts'), 'export const port = 3000;\n');
  succeed('git', ['add', '.']);
  succeed('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Baseline']);
  succeed('npm', ['run', 'prepare']);
  expect(succeed('git', ['config', 'core.hooksPath']).trim()).toBe('.husky/_');

  writeFileSync(join(directory, 'src/sample.ts'), [
    "import { AppConfig } from './config.js';",
    'export const config: AppConfig = { PORT: 3000 };',
    '',
  ].join('\n'));
  const unstagedPath = join(directory, 'src/unstaged.ts');
  const unstagedContent = 'export const broken = ;\n';
  writeFileSync(unstagedPath, unstagedContent);
  succeed('git', ['add', 'src/sample.ts']);
  succeed('git', ['commit', '--quiet', '-m', 'Autofix staged file']);
  expect(succeed('git', ['show', 'HEAD:src/sample.ts']))
    .toContain("import type { AppConfig } from './config.js';");
  expect(readFileSync(unstagedPath, 'utf8')).toBe(unstagedContent);

  const head = succeed('git', ['rev-parse', 'HEAD']);
  writeFileSync(join(directory, 'src/sample.ts'), 'const unused = 1;\nexport const port = 3000;\n');
  succeed('git', ['add', 'src/sample.ts']);
  const rejected = run('git', ['commit', '--quiet', '-m', 'Must be rejected']);
  expect(rejected.status).toBe(1);
  expect(rejected.stdout + rejected.stderr).toContain('@typescript-eslint/no-unused-vars');
  expect(succeed('git', ['rev-parse', 'HEAD'])).toBe(head);
}, 30000);
