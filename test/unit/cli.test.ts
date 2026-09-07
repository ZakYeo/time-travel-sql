import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runCli } from '@time-travel-sql/cli';
import { decodeTransaction } from '@time-travel-sql/sdk';
import { metadata, row } from '../../test-support/storage-fixture.js';
import { Client } from '../../packages/storage-local/dist/client.js';
import {
  fixture,
  seed,
  bytesFrom,
  signal,
} from '../../test-support/exchange-fixture.js';

const bin = resolve('apps/cli/dist/bin.js');
it('cancels a large result blocked on an unread stdout pipe', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await source.append(
      metadata.id,
      decodeTransaction(metadata.recording, {
        id: 'large',
        sourceId: 'source',
        epochId: 'epoch',
        schemaId: 'schema',
        position: '20',
        previousPosition: '10',
        events: Array.from({ length: 8000 }, (_, index) => ({
          kind: 'insert',
          tableId: 'orders',
          after: row(String(index + 100)).row,
        })),
      }),
    );
    await writeFile(join(root, 'input.tts'), await bytesFrom(root));
    await invoke(root, ['init', '--workspace', './workspace']);
    expect(
      (
        await invoke(root, [
          'import',
          'input.tts',
          '--workspace',
          './workspace',
        ])
      ).code,
    ).toBe(0);
    const result = await new Promise<{
      code: number | null;
      stderr: string;
      forced: boolean;
    }>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          bin,
          'transaction',
          'recording',
          '20',
          '--workspace',
          join(root, 'workspace'),
          '--json',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      let forced = false;
      const timer = setTimeout(() => {
        forced = true;
        child.kill('SIGKILL');
      }, 5000);
      child.stdout.once('readable', () => {
        child.kill('SIGINT');
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        child.stdout.destroy();
        child.once('close', () => done({ code, stderr, forced }));
      });
    });
    expect(result.forced).toBe(false);
    expect(result.code).toBe(130);
    expect(json(result.stderr)).toMatchObject({ error: { code: 'CANCELLED' } });
  });
});
async function cli(
  root: string,
  args: string[],
  env: Record<string, string> = {},
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (done) => {
      execFile(
        process.execPath,
        [bin, ...args],
        {
          cwd: root,
          env: { PATH: process.env.PATH, ...env },
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          done({
            code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            stdout,
            stderr,
          });
        },
      );
    },
  );
}
async function invoke(root: string, args: string[], cancellation = signal()) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    cwd: root,
    env: {},
    signal: cancellation,
    stdout: async (text) => {
      stdout += text;
    },
    stderr: async (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}
function json(text: string): unknown {
  return JSON.parse(text);
}

it('manages a portable recording through real CLI processes and reopens it offline', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await writeFile(join(root, 'input.tts'), await bytesFrom(root));
    await source.close();
    const options = ['--workspace', './workspace', '--json'];
    expect((await cli(root, ['init', ...options])).code).toBe(0);
    const imported = await cli(root, ['import', './input.tts', ...options]);
    expect(imported.code).toBe(0);
    expect(json(imported.stdout)).toMatchObject({
      version: 1,
      ok: true,
      data: { id: 'recording', headPosition: '10' },
    });
    expect((await cli(root, ['validate', 'recording', ...options])).code).toBe(
      0,
    );
    const renamed = await cli(root, [
      'rename',
      'recording',
      'Offline orders',
      ...options,
    ]);
    expect(json(renamed.stdout)).toMatchObject({
      data: { name: 'Offline orders' },
    });
    const inspected = await cli(root, ['inspect', 'recording', ...options]);
    expect(json(inspected.stdout)).toMatchObject({
      data: { name: 'Offline orders', headPosition: '10', transactionCount: 1 },
    });
    const listed = await cli(root, ['list', '--limit', '1', ...options]);
    expect(json(listed.stdout)).toMatchObject({
      data: { items: [{ id: 'recording', name: 'Offline orders' }] },
    });
    const tx = await cli(root, ['transaction', 'recording', '10', ...options]);
    expect(json(tx.stdout)).toMatchObject({
      data: { position: '10', previousPosition: '0' },
    });
    const exported = await cli(root, [
      'export',
      'recording',
      './output.tts',
      ...options,
    ]);
    expect(exported.code).toBe(0);
    const bytes = await readFile(join(root, 'output.tts'));
    const conflict = await cli(root, [
      'export',
      'recording',
      './output.tts',
      ...options,
    ]);
    expect(conflict.code).toBe(1);
    expect(conflict.stdout).toBe('');
    expect(json(conflict.stderr)).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_FAILURE' },
    });
    expect(await readFile(join(root, 'output.tts'))).toEqual(bytes);
    expect((await cli(root, ['remove', 'recording', ...options])).code).toBe(0);
    expect(json((await cli(root, ['list', ...options])).stdout)).toMatchObject({
      data: { items: [] },
    });
  });
});

it('resolves config-relative workspaces and flag/environment precedence without implicit initialization', async () => {
  await fixture(async (_source, _target, root) => {
    await mkdir(join(root, 'config'));
    await writeFile(
      join(root, 'config', 'settings.json'),
      JSON.stringify({ workspace: './configured', timeoutMs: 2000 }),
    );
    expect(
      (await cli(root, ['init', '--config', './config/settings.json'])).code,
    ).toBe(0);
    expect(
      (
        await stat(join(root, 'config', 'configured', 'history.sqlite'))
      ).isFile(),
    ).toBe(true);
    expect(
      (
        await cli(root, ['init', '--config', './config/settings.json'], {
          TTS_WORKSPACE: './environment',
        })
      ).code,
    ).toBe(0);
    expect(
      (await stat(join(root, 'environment', 'history.sqlite'))).isFile(),
    ).toBe(true);
    expect(
      (
        await cli(
          root,
          [
            'init',
            '--workspace',
            './flag',
            '--config',
            './config/settings.json',
          ],
          { TTS_WORKSPACE: './unused' },
        )
      ).code,
    ).toBe(0);
    expect((await stat(join(root, 'flag', 'history.sqlite'))).isFile()).toBe(
      true,
    );
    const missing = await cli(root, [
      'list',
      '--workspace',
      './missing',
      '--json',
    ]);
    expect(missing.code).toBe(1);
    await expect(stat(join(root, 'missing'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(missing.stderr).not.toContain(root);
  });
});

it('bounds config and arguments, preserves literal --json, and keeps help side-effect free', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await writeFile(join(root, 'input.tts'), await bytesFrom(root));
    expect(
      (await invoke(root, ['init', '--workspace', './workspace'])).code,
    ).toBe(0);
    expect(
      (
        await invoke(root, [
          'import',
          'input.tts',
          '--workspace',
          './workspace',
        ])
      ).code,
    ).toBe(0);
    const renamed = await invoke(root, [
      'rename',
      'recording',
      '--workspace',
      './workspace',
      '--',
      '--json',
    ]);
    expect(renamed.code).toBe(0);
    expect(json(renamed.stdout)).toMatchObject({ name: '--json' });
    expect(json(renamed.stdout)).not.toHaveProperty('version');
    for (const args of [
      ['list', '--limit', '101'],
      ['inspect'],
      ['list', '--json', '--json'],
      ['list', '--unknown'],
    ]) {
      expect(
        (await invoke(root, [...args, '--workspace', './workspace'])).code,
      ).toBe(2);
    }
    await writeFile(join(root, 'large.json'), ' '.repeat(65537));
    expect(
      (await invoke(root, ['list', '--config', './large.json', '--json'])).code,
    ).toBe(2);
    await writeFile(
      join(root, 'unknown.json'),
      '{"workspace":"./workspace","password":"private-value"}',
    );
    const invalid = await invoke(root, [
      'list',
      '--config',
      './unknown.json',
      '--json',
    ]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).not.toContain('private-value');
    const help = await cli(root, ['--help', '--workspace', './never-created']);
    expect(help.stdout).toContain('tts import');
    await expect(stat(join(root, 'never-created'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

it('owns a broken stdout pipe without printing an uncaught stack', async () => {
  const result = await new Promise<{ code: number | null; stderr: string }>(
    (done, reject) => {
      const child = spawn(process.execPath, [bin, '--help'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stdout.destroy();
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => done({ code, stderr }));
    },
  );
  expect(result.code).toBe(1);
  expect(result.stderr).not.toMatch(/Unhandled|at .*\.js|node:events/);
});

it.each(['external', 'deadline'] as const)(
  'retains %s cancellation across delayed read cleanup',
  async (mode) => {
    await fixture(async (_source, _target, root) => {
      await invoke(root, ['init', '--workspace', './workspace']);
      const controller = new AbortController();
      const original = Client.prototype.close;
      const mock = vi
        .spyOn(Client.prototype, 'close')
        .mockImplementation(async function (this: Client) {
          if (mode === 'external') controller.abort();
          await new Promise((done) => setTimeout(done, 2100));
          await original.call(this);
        });
      try {
        const result = await invoke(
          root,
          [
            'list',
            '--workspace',
            './workspace',
            '--timeout-ms',
            '2000',
            '--json',
          ],
          controller.signal,
        );
        expect(result.code).toBe(mode === 'external' ? 130 : 124);
        expect(result.stdout).toBe('');
        expect(json(result.stderr)).toMatchObject({
          error: { code: mode === 'external' ? 'CANCELLED' : 'TIMEOUT' },
        });
      } finally {
        mock.mockRestore();
      }
    });
  },
);
