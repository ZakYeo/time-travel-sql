import { expect, it } from 'vitest';
import { recordNextCommit, decodePosition } from '@time-travel-sql/sdk';
import type { SourceStream } from '@time-travel-sql/sdk';
import { metadata, transaction } from '../../test-support/storage-fixture.js';

function source(calls: string[]): SourceStream {
  return {
    recording: metadata.recording,
    async next() {
      calls.push('next');
      return transaction('10', '0', '1');
    },
    async acknowledge() {
      calls.push('ack');
    },
    async close() {
      calls.push('close');
    },
    status: () => ({
      state: 'streaming',
      durablePosition: decodePosition('0'),
      receivedPosition: decodePosition('0'),
    }),
  };
}

it('waits for durable append before acknowledging and leaves a successful source open', async () => {
  const calls: string[] = [];
  const appended = Promise.withResolvers<'appended'>();
  const entered = Promise.withResolvers<void>();
  const pending = recordNextCommit(
    source(calls),
    {
      append: () => {
        calls.push('append');
        entered.resolve();
        return appended.promise;
      },
    },
    metadata.id,
  );
  await entered.promise;
  expect(calls).toEqual(['next', 'append']);
  appended.resolve('appended');
  expect((await pending).position).toBe('10');
  expect(calls).toEqual(['next', 'append', 'ack']);
});

it('closes a source after persistence failure without acknowledgement', async () => {
  const calls: string[] = [];
  const failure = new Error('Durability failed');
  await expect(
    recordNextCommit(
      source(calls),
      {
        async append() {
          calls.push('append');
          throw failure;
        },
      },
      metadata.id,
    ),
  ).rejects.toBe(failure);
  expect(calls).toEqual(['next', 'append', 'close']);
});

it('retains both failures if the source cannot close after a failed append', async () => {
  const stream = source([]);
  const failure = new Error('append');
  const cleanup = new Error('close');
  await expect(
    recordNextCommit(
      {
        ...stream,
        async close() {
          throw cleanup;
        },
      },
      {
        async append() {
          throw failure;
        },
      },
      metadata.id,
    ),
  ).rejects.toMatchObject({
    code: 'STORAGE_FAILURE',
    cause: { errors: [failure, cleanup] },
  });
});
