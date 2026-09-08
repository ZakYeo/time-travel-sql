import { expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import type { Transferable } from 'node:worker_threads';
import { setTimeout } from 'node:timers/promises';
import { createHistoricalQueryEngine } from '@time-travel-sql/query-pglite';
import { decodeQueryRequest } from '@time-travel-sql/sdk';
import { pair, snapshot } from '../../test-support/investigation-fixture.js';

it('expires a deadline after schema and policy preparation and SQL dispatch', async () => {
  const engine = createHistoricalQueryEngine();
  const view = pair([], [snapshot('one')]).to;
  let dispatched = (): void => undefined;
  const executing = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const original = Worker.prototype.postMessage;
  const spy = vi
    .spyOn(Worker.prototype, 'postMessage')
    .mockImplementation(function (
      this: Worker,
      value: unknown,
      transferList?: readonly Transferable[],
    ) {
      original.call(this, value, transferList);
      if (
        value &&
        typeof value === 'object' &&
        'kind' in value &&
        value.kind === 'execute'
      )
        dispatched();
    });
  try {
    const pending = engine.query(
      view,
      decodeQueryRequest({
        sql: 'SELECT count(*) FROM generate_series(1,100000) a CROSS JOIN generate_series(1,100000) b',
        limits: { timeoutMs: 8000 },
      }),
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
    await Promise.race([executing, pending]);
    await setTimeout(100);
    expect(settled).toBe(false);
    await rejected;
    expect(
      (
        await engine.query(
          view,
          decodeQueryRequest({ sql: 'SELECT amount FROM orders' }),
        )
      ).rows,
    ).toEqual([['1.00']]);
  } finally {
    spy.mockRestore();
    await engine.close();
  }
});

it.each([false, true])(
  'reports a sole teardown failure and prevents reuse (concurrent close: %s)',
  async (concurrent) => {
    const engine = createHistoricalQueryEngine();
    const view = pair([], [snapshot('one')]).to;
    let entering = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      entering = resolve;
    });
    let finish = (): void => undefined;
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const failure = new Error('injected worker teardown failure');
    const terminate = Worker.prototype.terminate;
    const spy = vi
      .spyOn(Worker.prototype, 'terminate')
      .mockImplementation(async function (this: Worker) {
        await terminate.call(this);
        entering();
        await release;
        throw failure;
      });
    try {
      const pending = engine.query(
        view,
        decodeQueryRequest({ sql: 'SELECT 1' }),
      );
      const rejected = expect(pending).rejects.toBe(failure);
      await entered;
      const closed = concurrent ? engine.close() : undefined;
      const closeRejected = closed
        ? expect(closed).rejects.toMatchObject({ errors: [failure] })
        : undefined;
      finish();
      await rejected;
      if (closeRejected) await closeRejected;
      else {
        await expect(
          engine.query(view, decodeQueryRequest({ sql: 'SELECT 1' })),
        ).rejects.toMatchObject({ code: 'QUERY_FAILURE' });
        await expect(engine.close()).rejects.toMatchObject({
          errors: [failure],
        });
      }
    } finally {
      finish();
      spy.mockRestore();
    }
  },
);
