import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { API_PATH } from '@time-travel-sql/contracts';

it('serves beyond its configuration deadline and drains cleanly on SIGINT', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tts-serve-'));
  const child = spawn(
    process.execPath,
    [
      resolve('apps/cli/dist/bin.js'),
      'serve',
      '--workspace',
      workspace,
      '--timeout-ms',
      '1000',
      '--json',
    ],
    { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  try {
    const line = await Promise.race([
      new Promise<string>((done) => lines.once('line', done)),
      exited.then((code) => {
        throw new Error('Server exited before ready: ' + code + ' ' + stderr);
      }),
    ]);
    const ready = JSON.parse(line);
    expect(ready).toMatchObject({
      version: 1,
      ok: true,
      data: { endpoint: API_PATH },
    });
    await setTimeout(1100);
    const response = await fetch(ready.data.origin + API_PATH, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + ready.data.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        version: 1,
        operation: 'list',
        page: { limit: 10, cursor: null },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { items: [] } });
    child.kill('SIGINT');
    expect(await exited).toBe(0);
    expect(stderr).toBe('');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    lines.close();
    await rm(workspace, { recursive: true, force: true });
  }
}, 15000);
