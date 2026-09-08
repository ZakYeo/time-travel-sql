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
async function invoke(root: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (done, reject) => {
      execFile(
        process.execPath,
        [bin, ...args, '--workspace', join(root, 'workspace'), '--json'],
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
async function imported(root: string, bytes: Uint8Array) {
  await writeFile(join(root, 'input.tts'), bytes);
  expect((await invoke(root, ['init'])).code).toBe(0);
  expect((await invoke(root, ['import', 'input.tts'])).code).toBe(0);
}

it('executes offline selected SQL through the real CLI with exact JSON and explicit failures', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await imported(root, await bytesFrom(root));
    await source.close();
    const before = await invoke(root, [
      'query',
      'recording',
      'before:10',
      'SELECT id FROM orders',
    ]);
    expect(before.code).toBe(0);
    expect(before.stderr).toBe('');
    expect(JSON.parse(before.stdout)).toMatchObject({
      version: 1,
      ok: true,
      data: {
        info: { position: '0', selection: { kind: 'before', position: '10' } },
        rows: [['1']],
      },
    });
    const joined = await invoke(root, [
      'query',
      'recording',
      'after:10',
      'SELECT count(*),sum(a.id+b.id) FROM orders a JOIN orders b ON a.id=b.id',
    ]);
    expect(JSON.parse(joined.stdout)).toMatchObject({
      data: { info: { position: '10' }, rows: [['2', '6']] },
    });
    for (const [sql, flags, code] of [
      ['SELECT id FROM orders', ['--limit', '1'], 'LIMIT_EXCEEDED'],
      ['DELETE FROM orders', [], 'QUERY_REJECTED'],
    ] as const) {
      const result = await invoke(root, [
        'query',
        'recording',
        'after:10',
        sql,
        ...flags,
      ]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        error: { code },
      });
    }
    const unknown = await invoke(root, [
      'query',
      'recording',
      'after:9',
      'SELECT 1',
    ]);
    expect(JSON.parse(unknown.stderr)).toMatchObject({
      error: { code: 'INVALID_HISTORY' },
    });
    expect(
      (await invoke(root, ['query', 'recording', 'latest', 'SELECT 1'])).code,
    ).toBe(2);
    expect(
      (
        await invoke(root, [
          'query',
          'recording',
          'baseline',
          'SELECT 1',
          '--cursor',
          'no',
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await invoke(root, [
          'query',
          'recording',
          'baseline',
          'SELECT 1',
          '--limit',
          '10001',
        ])
      ).code,
    ).toBe(2);
    const text = await invoke(root, [
      'query',
      'recording',
      'baseline',
      "SELECT E'\\033[31mrecorded' AS text",
    ]);
    expect(text.code).toBe(0);
    expect(text.stdout).not.toContain('\x1b');
    expect(JSON.parse(text.stdout)).toMatchObject({
      data: { rows: [['\x1b[31mrecorded']] },
    });
    expect((await invoke(root, ['validate', 'recording'])).code).toBe(0);
  });
});

it('reports a command deadline with empty stdout and exit 124', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await imported(root, await bytesFrom(root));
    const result = await invoke(root, [
      'query',
      'recording',
      'baseline',
      'SELECT count(*) FROM generate_series(1,100000) a CROSS JOIN generate_series(1,100000) b',
      '--timeout-ms',
      '4000',
    ]);
    expect(result.code).toBe(124);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'TIMEOUT' },
    });
  });
});

it('handles SIGINT after the actual CLI dispatches expensive historical SQL', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await imported(root, await bytesFrom(root));
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      forced: boolean;
      executing: boolean;
    }>((done, reject) => {
      const child = fork(
        bin,
        [
          'query',
          'recording',
          'baseline',
          'SELECT count(*) FROM generate_series(1,100000) a CROSS JOIN generate_series(1,100000) b',
          '--workspace',
          join(root, 'workspace'),
          '--json',
        ],
        {
          cwd: root,
          execArgv: [
            '--import',
            new URL(
              '../../test-support/cli-query-observer.mjs',
              import.meta.url,
            ).href,
          ],
          silent: true,
        },
      );
      let stdout = '';
      let stderr = '';
      let executing = false;
      let forced = false;
      const watchdog = setTimeout(() => {
        forced = true;
        child.kill('SIGKILL');
      }, 15000);
      let interrupt: ReturnType<typeof setTimeout> | undefined;
      child.stdout?.setEncoding('utf8').on('data', (text: string) => {
        stdout += text;
      });
      child.stderr?.setEncoding('utf8').on('data', (text: string) => {
        stderr += text;
      });
      child.on('message', (message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'kind' in message &&
          message.kind === 'query-executing'
        ) {
          executing = true;
          interrupt = setTimeout(() => child.kill('SIGINT'), 100);
        }
      });
      child.once('error', (error) => {
        clearTimeout(watchdog);
        clearTimeout(interrupt);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(watchdog);
        clearTimeout(interrupt);
        done({ code, stdout, stderr, forced, executing });
      });
    });
    expect(result).toMatchObject({
      code: 130,
      stdout: '',
      forced: false,
      executing: true,
    });
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'CANCELLED' },
    });
  });
});
