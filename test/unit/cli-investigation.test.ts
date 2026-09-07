import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { runCli } from '@time-travel-sql/cli';
import {
  fixture,
  seed,
  bytesFrom,
  signal,
} from '../../test-support/exchange-fixture.js';

it('inspects and compares exact offline selections with stable pagination and explicit errors', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await writeFile(join(root, 'input.tts'), await bytesFrom(root));
    await source.close();
    async function run(args: string[]) {
      let stdout = '';
      let stderr = '';
      const code = await runCli(
        [...args, '--workspace', './workspace', '--json'],
        {
          cwd: root,
          env: {},
          signal: signal(),
          stdout: async (value) => {
            stdout += value;
          },
          stderr: async (value) => {
            stderr += value;
          },
        },
      );
      const result: unknown = JSON.parse(stdout || stderr);
      return { code, result };
    }
    expect((await run(['init'])).code).toBe(0);
    expect((await run(['import', 'input.tts'])).code).toBe(0);
    const first = await run([
      'rows',
      'recording',
      'orders',
      'after:10',
      '--limit',
      '1',
    ]);
    expect(first).toMatchObject({
      code: 0,
      result: {
        data: {
          info: { position: '10' },
          total: 2,
          nextOffset: 1,
          items: [{ row: [{ value: '1' }] }],
        },
      },
    });
    const next = await run([
      'rows',
      'recording',
      'orders',
      'after:10',
      '--limit',
      '1',
      '--offset',
      '1',
    ]);
    expect(next).toMatchObject({
      code: 0,
      result: {
        data: { nextOffset: null, items: [{ row: [{ value: '2' }] }] },
      },
    });
    const before = await run(['rows', 'recording', 'orders', 'before:10']);
    expect(before).toMatchObject({
      code: 0,
      result: {
        data: {
          info: {
            position: '0',
            selection: { kind: 'before', position: '10' },
          },
          total: 1,
        },
      },
    });
    const compared = await run([
      'compare',
      'recording',
      'orders',
      'baseline',
      'after:10',
    ]);
    expect(compared).toMatchObject({
      code: 0,
      result: {
        data: {
          from: { position: '0' },
          to: { position: '10' },
          counts: { inserted: 1, deleted: 0, updated: 0, unchanged: 1 },
        },
      },
    });
    expect(
      (await run(['rows', 'recording', 'orders', 'after:9'])).result,
    ).toMatchObject({ ok: false, error: { code: 'INVALID_HISTORY' } });
    expect(
      (await run(['rows', 'recording', 'missing', 'baseline'])).result,
    ).toMatchObject({ ok: false, error: { code: 'INVALID_SCHEMA' } });
    expect((await run(['rows', 'recording', 'orders', 'latest'])).code).toBe(2);
    expect(
      (
        await run([
          'rows',
          'recording',
          'orders',
          'baseline',
          '--cursor',
          'wrong',
        ])
      ).code,
    ).toBe(2);
  });
});
