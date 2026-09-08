import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  rowHistoryFixture,
  lifecycleKey,
} from '../../test-support/row-history-fixture.js';
import { bytesFrom } from '../../test-support/exchange-fixture.js';

const execute = promisify(execFile);
it('follows an imported row lifecycle offline through actual CLI arguments and offset pages', async () => {
  await rowHistoryFixture(async (_history, source, root) => {
    const file = join(root, 'portable.tts');
    await writeFile(file, await bytesFrom(root));
    await source.remove('recording');
    const run = async (args: readonly string[]) => {
      const result = await execute(
        process.execPath,
        [
          resolve('apps/cli/dist/bin.js'),
          ...args,
          '--workspace',
          join(root, 'fresh'),
          '--json',
        ],
        { cwd: root, timeout: 15000 },
      );
      expect(result.stderr).toBe('');
      return JSON.parse(result.stdout);
    };
    await run(['init']);
    await run(['import', file]);
    const original = await run([
      'row-history',
      'recording',
      'orders',
      'after:20',
      lifecycleKey('d'),
      '--limit',
      '2',
    ]);
    expect(original).toMatchObject({
      version: 1,
      ok: true,
      data: {
        status: 'deleted',
        total: 5,
        nextOffset: 2,
        items: [{ kind: 'baseline' }, { kind: 'update' }],
      },
    });
    const remaining = await run([
      'row-history',
      'recording',
      'orders',
      'after:20',
      lifecycleKey('d'),
      '--offset',
      '2',
    ]);
    expect(remaining.data).toMatchObject({
      total: 5,
      nextOffset: null,
      items: [
        { kind: 'update', position: '20', eventIndex: 0 },
        { kind: 'update', position: '20', eventIndex: 1 },
        { kind: 'delete', position: '30', eventIndex: 0 },
      ],
    });
    const beyond = await run([
      'row-history',
      'recording',
      'orders',
      'after:20',
      lifecycleKey('d'),
      '--offset',
      '2000000',
    ]);
    expect(beyond.data).toMatchObject({
      total: 5,
      nextOffset: null,
      items: [],
    });
    const reused = await run([
      'row-history',
      'recording',
      'orders',
      'after:30',
      lifecycleKey('d'),
    ]);
    expect(reused.data).toMatchObject({
      total: 2,
      status: 'present',
      currentKey: lifecycleKey('e'),
    });
  });
});
