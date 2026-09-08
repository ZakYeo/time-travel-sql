import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { decodePosition, scalarValue } from '@time-travel-sql/sdk';
import { fixture, bytesFrom } from '../../test-support/exchange-fixture.js';
import { metadata } from '../../test-support/storage-fixture.js';
import {
  recording,
  snapshot,
} from '../../test-support/investigation-fixture.js';

const execute = promisify(execFile);
it('shares through the real CLI and queries the imported projection offline with truthful restrictions', async () => {
  await fixture(async (source, _target, root) => {
    await source.create({ ...metadata, recording });
    await source.stageBaseline(metadata.id, [
      snapshot(
        'a',
        '9007199254740993.00',
        scalarValue('text', 'PRIVATE_CLI_MARKER'),
      ),
    ]);
    await source.publishBaseline(metadata.id, decodePosition('0'));
    const original = join(root, 'original.tts');
    await writeFile(original, await bytesFrom(root));
    const policy = join(root, 'policy.json');
    await writeFile(
      policy,
      JSON.stringify({
        version: 1,
        rules: [
          {
            namespace: 'public',
            table: 'orders',
            column: 'note',
            action: 'exclude',
          },
        ],
      }),
    );
    const run = async (workspace: string, args: readonly string[]) => {
      const result = await execute(
        process.execPath,
        [
          resolve('apps/cli/dist/bin.js'),
          ...args,
          '--workspace',
          join(root, workspace),
          '--json',
        ],
        { cwd: root, timeout: 30000 },
      );
      expect(result.stderr).toBe('');
      return JSON.parse(result.stdout);
    };
    await run('local', ['init']);
    await run('local', ['import', original]);
    const file = join(root, 'share.tts');
    const shared = await run('local', [
      'export-derived',
      'recording',
      file,
      'shared',
      'Shared example',
      policy,
    ]);
    expect(shared.data.recording.derivation).toMatchObject({
      liveResume: false,
      capabilities: ['committed-replay', 'row-history', 'available-column-sql'],
    });
    expect((await readFile(file)).toString()).not.toContain(
      'PRIVATE_CLI_MARKER',
    );
    await run('local', ['remove', 'recording']);
    await source.remove(metadata.id);
    await run('fresh', ['init']);
    await run('fresh', ['import', file]);
    const inspected = await run('fresh', ['inspect', 'shared']);
    expect(inspected.data.recording.derivation).toEqual(
      shared.data.recording.derivation,
    );
    const query = await run('fresh', [
      'query',
      'shared',
      'baseline',
      'SELECT id, amount FROM public.orders',
    ]);
    expect(JSON.stringify(query.data)).toContain('9007199254740993.00');
    await expect(
      run('fresh', [
        'query',
        'shared',
        'baseline',
        'SELECT note FROM public.orders',
      ]),
    ).rejects.toMatchObject({ code: 1 });
    const rows = await run('fresh', ['rows', 'shared', 'orders', 'baseline']);
    expect(JSON.stringify(rows.data)).toContain('excluded');
  });
});
