import { execFile, fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  fixture,
  seed,
  bytesFrom,
} from '../../test-support/exchange-fixture.js';

const bin = resolve('apps/cli/dist/bin.js');
async function invoke(root: string, args: string[], json = true) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (done, reject) => {
      execFile(
        process.execPath,
        [
          bin,
          ...args,
          '--workspace',
          join(root, 'workspace'),
          ...(json ? ['--json'] : []),
        ],
        { cwd: root, timeout: 20000, maxBuffer: 2 * 1048576 },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') {
            reject(error);
            return;
          }
          done({
            code: typeof error?.code === 'number' ? error.code : 0,
            stdout,
            stderr,
          });
        },
      );
    },
  );
}
async function prepare(root: string, bytes: Uint8Array) {
  await writeFile(join(root, 'input.tts'), bytes);
  expect((await invoke(root, ['init'])).code).toBe(0);
  expect((await invoke(root, ['import', 'input.tts'])).code).toBe(0);
}

it('saves and runs SQL checks through the offline CLI with bounded findings and readable incomplete reports', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await prepare(root, await bytesFrom(root));
    await source.close();
    const sql = 'SELECT id FROM orders WHERE id=2';
    expect(
      (
        await invoke(root, [
          'save-check',
          'recording',
          'two',
          'Second row present',
          sql,
        ])
      ).code,
    ).toBe(0);
    const shown = await invoke(root, ['show-check', 'recording', 'two']);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      data: { id: 'two', query: { sql } },
    });
    expect(
      JSON.parse(
        (await invoke(root, ['list-checks', 'recording', '--limit', '1']))
          .stdout,
      ),
    ).toMatchObject({ data: { items: [{ id: 'two' }], nextCursor: null } });
    const scan = await invoke(root, [
      'scan-check',
      'recording',
      'two',
      'baseline',
      'after:10',
    ]);
    expect(scan.code).toBe(0);
    expect(scan.stderr).toBe('');
    expect(JSON.parse(scan.stdout)).toMatchObject({
      version: 1,
      ok: true,
      data: {
        check: { id: 'two', query: { sql } },
        range: { from: '0', to: '10' },
        progress: { evaluatedStates: 2 },
        outcome: {
          kind: 'violation',
          position: '10',
          predecessor: '0',
          rows: { rows: [['2']] },
          diff: { counts: { inserted: 1 } },
        },
      },
    });
    for (const json of [true, false]) {
      const limited = await invoke(
        root,
        [
          'scan-check',
          'recording',
          'two',
          'baseline',
          'after:10',
          '--max-states',
          '1',
        ],
        json,
      );
      expect(limited.code).toBe(1);
      expect(limited.stdout).toBe('');
      const report = json
        ? JSON.parse(limited.stderr).data
        : JSON.parse(limited.stderr.slice(limited.stderr.indexOf('\n') + 1));
      expect(report).toMatchObject({
        range: { from: '0', to: '10' },
        outcome: { kind: 'incomplete', reason: 'limit' },
        progress: { evaluatedStates: 1, lastEvaluatedPosition: '0' },
      });
    }
    expect(
      (
        await invoke(root, [
          'scan-check',
          'recording',
          'two',
          'latest',
          'after:10',
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await invoke(root, [
          'scan-check',
          'recording',
          'two',
          'baseline',
          'after:10',
          '--max-states',
          '10001',
        ])
      ).code,
    ).toBe(2);
    expect(
      (await invoke(root, ['remove-check', 'recording', 'two'])).code,
    ).toBe(0);
    expect((await invoke(root, ['show-check', 'recording', 'two'])).code).toBe(
      1,
    );
  });
}, 60000);

it('reports an overall deadline consistently as TIMEOUT and incomplete/timeout', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await prepare(root, await bytesFrom(root));
    expect(
      (
        await invoke(root, [
          'save-check',
          'recording',
          'slow',
          'Slow predicate',
          'SELECT count(*) FROM generate_series(1,100000) a CROSS JOIN generate_series(1,100000) b',
        ])
      ).code,
    ).toBe(0);
    const result = await invoke(root, [
      'scan-check',
      'recording',
      'slow',
      'baseline',
      'after:10',
      '--timeout-ms',
      '4000',
    ]);
    expect(result.code).toBe(124);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'TIMEOUT' },
      data: {
        outcome: { kind: 'incomplete', reason: 'timeout' },
        progress: { evaluatedStates: 0, lastEvaluatedPosition: null },
      },
    });
  });
});

it('reports cancellation after observed SQL dispatch and releases the executable without a forced kill', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await prepare(root, await bytesFrom(root));
    await invoke(root, [
      'save-check',
      'recording',
      'slow',
      'Slow predicate',
      'SELECT count(*) FROM generate_series(1,100000) a CROSS JOIN generate_series(1,100000) b',
    ]);
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      observed: boolean;
      forced: boolean;
    }>((done, reject) => {
      const child = fork(
        bin,
        [
          'scan-check',
          'recording',
          'slow',
          'baseline',
          'after:10',
          '--workspace',
          join(root, 'workspace'),
          '--json',
        ],
        {
          cwd: root,
          silent: true,
          execArgv: [
            '--import',
            resolve('test-support/cli-query-observer.mjs'),
          ],
        },
      );
      let stdout = '',
        stderr = '';
      let observed = false,
        forced = false;
      const timer = setTimeout(() => {
        forced = true;
        child.kill('SIGKILL');
      }, 15000);
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('message', (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'kind' in message &&
          message.kind === 'query-executing'
        ) {
          observed = true;
          child.kill('SIGINT');
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        done({ code, stdout, stderr, observed, forced });
      });
    });
    expect(result).toMatchObject({
      code: 130,
      stdout: '',
      observed: true,
      forced: false,
    });
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'CANCELLED' },
      data: {
        range: { from: '0', to: '10' },
        outcome: { kind: 'incomplete', reason: 'cancelled' },
        progress: { evaluatedStates: 0, lastEvaluatedPosition: null },
      },
    });
  });
});
