import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const bin = resolve('apps/cli/dist/bin.js');
const id = 'sample-checkout-v1';
const sql =
  'SELECT o.id FROM orders o JOIN line_items l ON l."orderId"=o.id GROUP BY o.id,o.total HAVING o.total <> sum(l.quantity*l."unitPrice")';

it('loads the bundled sample in a fresh workspace and reproduces its investigation after sharing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-sample-cli-'));
  const run = (workspace: string, args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>(
      (done, reject) => {
        execFile(
          process.execPath,
          [bin, ...args, '--workspace', join(root, workspace), '--json'],
          {
            cwd: root,
            timeout: 25000,
            maxBuffer: 2 * 1048576,
            env: { PATH: process.env.PATH },
          },
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
  const success = async (workspace: string, args: string[]) => {
    const result = await run(workspace, args);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  };
  try {
    expect(await success('first', ['sample'])).toMatchObject({
      data: {
        id,
        name: 'Sample: checkout totals',
        status: 'stopped',
        baselinePosition: '0',
        headPosition: '40',
        transactionCount: 4,
        recording: { sourceId: 'sample-checkout', epochId: 'sample-v1' },
      },
    });
    await success('first', ['rename', id, 'My sample investigation']);
    const repeated = await run('first', ['sample']);
    expect(repeated.code).toBe(1);
    expect(repeated.stdout).toBe('');
    expect(await success('first', ['inspect', id])).toMatchObject({
      data: { name: 'My sample investigation' },
    });
    expect(
      await success('first', ['query', id, 'before:20', sql]),
    ).toMatchObject({ data: { info: { position: '10' }, rows: [] } });
    const violation = await success('first', ['query', id, 'after:20', sql]);
    expect(violation).toMatchObject({
      data: { info: { position: '20' }, rows: [['order-2']] },
    });
    expect(
      await success('first', ['query', id, 'after:30', sql]),
    ).toMatchObject({ data: { info: { position: '30' }, rows: [] } });
    expect(await success('first', ['transaction', id, '20'])).toMatchObject({
      data: {
        context: {
          operation: 'checkout.create',
          requestId: 'sample-request-2',
        },
        events: [{ kind: 'insert' }, { kind: 'insert' }, { kind: 'update' }],
      },
    });
    await success('first', [
      'save-check',
      id,
      'totals',
      'Order totals match line items',
      sql,
    ]);
    expect(
      await success('first', [
        'scan-check',
        id,
        'totals',
        'baseline',
        'after:40',
      ]),
    ).toMatchObject({
      data: {
        outcome: {
          kind: 'violation',
          position: '20',
          predecessor: '10',
          rows: { rows: [['order-2']] },
        },
      },
    });
    await success('first', ['export', id, join(root, 'shared.tts')]);
    await success('first', ['remove', id]);
    await success('second', ['init']);
    await success('second', ['import', join(root, 'shared.tts')]);
    expect(
      await success('second', ['query', id, 'after:20', sql]),
    ).toMatchObject({
      data: { info: { position: '20' }, rows: violation.data.rows },
    });
    expect(await success('second', ['validate', id])).toMatchObject({
      data: { valid: true },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
