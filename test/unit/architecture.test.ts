import { mkdtemp, mkdir, writeFile, cp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function checkGraph(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), 'tts-boundary-'));
  temporary.push(root);
  for (const file of ['.dependency-cruiser.mjs', 'tsconfig.base.json'])
    await cp(file, join(root, file));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(
      join(root, file),
      content.replaceAll('__FIXTURE_ROOT__', root),
    );
  }
  if (files['packages/example/package.json']) {
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink('../packages/example', join(root, 'node_modules/example'));
  }
  const roots = [
    ...new Set(Object.keys(files).map((file) => file.split('/')[0] ?? '')),
  ].filter((root) => root !== 'node_modules' && root !== 'package.json');
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/dependency-cruiser/bin/dependency-cruise.mjs'),
      ...roots,
      '--config',
      '.dependency-cruiser.mjs',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

it.each([
  ['packages/sdk/src/domain/entry.ts', 'node:fs', 'domain-is-pure'],
  [
    'packages/contracts/src/index.ts',
    'node:http',
    'contracts-are-browser-safe',
  ],
  ['packages/sdk/src/index.ts', 'node:sqlite', 'sdk-is-independent'],
  ['apps/web/src/index.ts', 'node:fs', 'browser-not-node'],
])('rejects forbidden runtime import from %s', async (file, target, rule) => {
  const result = await checkGraph({ [file]: `import '${target}';` });
  expect(result.status).toBeGreaterThan(0);
  expect(result.output).toContain(rule);
});

it('rejects adapter coupling to composition and private cross-package imports', async () => {
  const result = await checkGraph({
    'packages/source-postgres/src/index.ts':
      "import '../../../apps/cli/src/index.js';",
    'apps/cli/src/index.ts': 'export const version = 1;',
  });
  expect(result.status).toBeGreaterThan(0);
  expect(result.output).toContain('adapters-not-composition');
  expect(result.output).toContain('public-imports-only-apps-cli');
});

it('rejects browser coupling to concrete adapters', async () => {
  const result = await checkGraph({
    'apps/web/src/index.ts':
      "import '../../../packages/query-local/src/index.js';",
    'packages/query-local/src/index.ts': 'export const version = 1;',
  });
  expect(result.status).toBeGreaterThan(0);
  expect(result.output).toContain('browser-not-adapters');
});

it('allows domain-local dependencies', async () => {
  const result = await checkGraph({
    'packages/sdk/src/domain/index.ts': "import './value.js';",
    'packages/sdk/src/domain/value.ts': 'export const version = 1;',
  });
  expect(result.status, result.output).toBe(0);
});

it.each([
  ['packages/source-postgres/src/index.ts', true],
  ['packages/sdk/src/domain/index.ts', false],
])('preserves ESM compiled-package edges from %s', async (file, allowed) => {
  const result = await checkGraph({
    [file]: "import 'transport';",
    'node_modules/transport/package.json': JSON.stringify({
      name: 'transport',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { import: './dist/index.js' } },
    }),
    'node_modules/transport/dist/index.js': 'export const version = 1;',
  });
  if (allowed) expect(result.status, result.output).toBe(0);
  else {
    expect(result.status).toBeGreaterThan(0);
    expect(result.output).toContain('domain-is-pure');
  }
});

it.each([
  ['packages/sdk/src/domain/index.ts', 'pg', 'domain-is-pure', false],
  ['apps/web/src/index.ts', 'pg', 'browser-runtime-allowlist', false],
  ['apps/web/src/index.ts', 'preact', '', true],
])(
  'validates resolved external dependency %s → %s',
  async (file, dependency, rule, allowed) => {
    const result = await checkGraph({
      [file]: `import '${dependency}';`,
      [`node_modules/${dependency}/package.json`]: JSON.stringify({
        name: dependency,
        version: '1.0.0',
        main: 'index.js',
      }),
      [`node_modules/${dependency}/index.js`]: 'export const version = 1;',
    });
    if (allowed) expect(result.status, result.output).toBe(0);
    else {
      expect(result.status).toBeGreaterThan(0);
      expect(result.output).toContain(rule);
    }
  },
);

it.each([
  ['export const parse = () => 1;', false],
  [
    "import { decodePosition } from '../domain/position.js'; export { decodePosition };",
    false,
  ],
  ['export interface Session { close(): Promise<void> }', true],
  [
    "import type { Position } from '../domain/position.js'; export type Cursor = Position;",
    true,
  ],
])('enforces type-only ports: %s', (input, allowed) => {
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/eslint/bin/eslint.js'),
      '--stdin',
      '--stdin-filename',
      'packages/sdk/src/ports/fixture.ts',
    ],
    { input, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(allowed ? 0 : 1);
  if (!allowed)
    expect(result.stdout).toContain('Ports contain type-only contracts');
});

it('keeps query adapters independent of source and storage and SQL utilities out of browsers', async () => {
  const result = await checkGraph({
    'packages/query-pglite/src/index.ts':
      "import '../../source-postgres/src/index.js'; import '../../storage-local/src/index.js';",
    'packages/source-postgres/src/index.ts': 'export const source = 1;',
    'packages/storage-local/src/index.ts': 'export const storage = 1;',
    'packages/sql-postgres/src/index.ts': 'export const sql = 1;',
    'apps/web/src/index.ts':
      "import '../../../packages/sql-postgres/src/index.js';",
  });
  expect(result.status).toBeGreaterThan(0);
  expect(result.output).toContain('query-has-no-source-or-storage');
  expect(result.output).toContain('browser-not-adapters');
});

it.each([
  ['example', ''],
  ['example/src/private.js', 'no-unresolved'],
  [
    '__FIXTURE_ROOT__/packages/example/src/private.js',
    'workspace-alias-public-entry-packages-example',
  ],
  [
    '../packages/example/src/private.js',
    'public-imports-only-packages-example',
  ],
])(
  'limits workspace aliases to public entries: %s',
  async (specifier, rule) => {
    const result = await checkGraph({
      'package.json': JSON.stringify({
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/example/package.json': JSON.stringify({
        name: 'example',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './dist/index.js' },
      }),
      'packages/example/dist/index.js': 'export const value = 1;',
      'packages/example/src/private.js': 'export const secret = 2;',
      'examples/probe.ts': `import '${specifier}';`,
    });
    if (!rule) expect(result.status, result.output).toBe(0);
    else {
      expect(result.status, result.output).toBeGreaterThan(0);
      expect(result.output).toContain(rule);
    }
  },
);
