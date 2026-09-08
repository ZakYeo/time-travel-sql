import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { decodeDataArray, decodeDataFields } from '@time-travel-sql/sdk';
import { withPostgres } from '../../test-support/postgres.js';

const execute = promisify(execFile);
it('installs the packed integration and compiles a generated Prisma client against real PostgreSQL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-prisma-consumer-'));
  const cache = process.env.TTS_NPM_CACHE
    ? ['--cache', process.env.TTS_NPM_CACHE]
    : [];
  const environment = {
    ...process.env,
    CHECKPOINT_DISABLE: '1',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
  };
  const run = (file: string, args: readonly string[], cwd = root) =>
    execute(file, [...args], {
      cwd,
      env: environment,
      timeout: 45000,
      maxBuffer: 2 * 1024 * 1024,
    });
  try {
    const packed = await run(
      'npm',
      [
        'pack',
        ...[
          'sdk',
          'sql-postgres',
          'source-postgres',
          'integration-prisma',
        ].flatMap((name) => ['--workspace', '@time-travel-sql/' + name]),
        '--pack-destination',
        root,
        '--json',
        ...cache,
      ],
      resolve('.'),
    );
    const files = decodeDataArray(JSON.parse(packed.stdout), 4).map((item) => {
      // npm's manifest contains additional standard fields; only filename selects a known local artifact.
      if (
        typeof item !== 'object' ||
        item === null ||
        !('filename' in item) ||
        typeof item.filename !== 'string' ||
        !/^time-travel-sql-[a-z-]+-0\.1\.0\.tgz$/.test(item.filename)
      )
        throw new Error('Unexpected packed artifact');
      return join(root, item.filename);
    });
    expect(files).toHaveLength(4);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    await run('npm', [
      'install',
      '--prefer-offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...cache,
      ...files,
      'prisma@7.10.0',
      '@prisma/client@7.10.0',
      '@prisma/adapter-pg@7.10.0',
      'typescript@5.9.3',
      '@types/node@24.10.1',
      '@types/pg@8.23.1',
    ]);
    for (const directory of ['examples/checkout', 'test-support'])
      await mkdir(join(root, directory), { recursive: true });
    for (const file of [
      'examples/checkout/schema.prisma',
      'examples/checkout/schema.sql',
      'examples/checkout/prisma-checkout.ts',
      'examples/checkout/request.ts',
      'test-support/prisma-consumer.ts',
    ])
      await copyFile(file, join(root, file));
    await run(process.execPath, [
      'node_modules/prisma/build/index.js',
      'generate',
      '--schema',
      'examples/checkout/schema.prisma',
      '--no-hints',
    ]);
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          skipLibCheck: true,
          outDir: 'dist',
          types: ['node'],
        },
        include: ['test-support/**/*.ts', 'examples/**/*.ts'],
      }),
    );
    await run(process.execPath, [
      'node_modules/typescript/bin/tsc',
      '-p',
      'tsconfig.json',
    ]);
    await withPostgres(async (connection) => {
      const result = await run(process.execPath, [
        'dist/test-support/prisma-consumer.js',
        JSON.stringify(connection),
      ]);
      expect(
        decodeDataFields(JSON.parse(result.stdout), [
          'packedIntegration',
          'generatedClient',
          'rollback',
          'context',
        ]),
      ).toEqual({
        packedIntegration: true,
        generatedClient: true,
        rollback: true,
        context: 'checkout.create',
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
