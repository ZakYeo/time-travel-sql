import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openLocalStore } from '@time-travel-sql/storage-local';
import {
  startRecording,
  HistoryError,
  decodePosition,
} from '@time-travel-sql/sdk';
import type { CommittedTransaction, SourceStream } from '@time-travel-sql/sdk';
import { metadata, transaction } from '../../test-support/storage-fixture.js';

function source() {
  const next = Promise.withResolvers<CommittedTransaction>();
  let closes = 0;
  const acknowledgements: string[] = [];
  const stream: SourceStream = {
    recording: metadata.recording,
    next: () => next.promise,
    async acknowledge(position) {
      acknowledgements.push(position);
    },
    status: () => ({
      state: 'streaming',
      durablePosition: decodePosition('0'),
      receivedPosition: decodePosition('0'),
    }),
    async close() {
      closes++;
      next.reject(new HistoryError('CANCELLED', 'Closed'));
    },
  };
  // Some startup rejection tests close before the first read.
  void next.promise.catch(() => {
    /* The consumer checks its outcome. */
  });
  return { stream, next, acknowledgements, closes: () => closes };
}

async function withStore(
  work: (store: Awaited<ReturnType<typeof openLocalStore>>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'tts-recorder-'));
  const store = await openLocalStore({ path: join(root, 'history.sqlite') });
  try {
    await store.create(metadata);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await work(store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

it('stops an idle read, persists stopped state and closes exactly once', async () => {
  await withStore(async (store) => {
    const input = source();
    const session = await startRecording(input.stream, store, metadata.id);
    const stopped = session.stop();
    expect(session.stop()).toBe(stopped);
    expect(await stopped).toMatchObject({
      status: 'stopped',
      headPosition: '0',
    });
    expect(await session.done).toEqual(await store.info(metadata.id));
    expect(input.closes()).toBe(1);
  });
});

it('accepts a commit buffered before recorder startup', async () => {
  await withStore(async (store) => {
    const input = source();
    input.next.resolve(transaction('10', '0', '1'));
    const session = await startRecording(
      {
        ...input.stream,
        status: () => ({
          ...input.stream.status(),
          state: 'waiting-for-durable',
        }),
      },
      store,
      metadata.id,
    );
    expect(await session.stop()).toMatchObject({ status: 'stopped' });
  });
});

it('preserves terminal source cancellation queued before owned close begins', async () => {
  await withStore(async (store) => {
    const input = source();
    let terminal = false;
    const failure = new HistoryError('CANCELLED', 'External cancellation');
    const session = await startRecording(
      {
        ...input.stream,
        status: () => ({
          ...input.stream.status(),
          state: terminal ? 'closed' : 'streaming',
        }),
      },
      store,
      metadata.id,
    );
    void Promise.resolve().then(() => {
      terminal = true;
      input.next.reject(failure);
    });
    await expect(session.stop()).rejects.toBe(failure);
    expect((await store.info(metadata.id)).status).toBe('interrupted');
  });
});

it.each(['read', 'ack'] as const)(
  'preserves an already rejected external %s cancellation when stop follows immediately',
  async (phase) => {
    await withStore(async (store) => {
      const input = source();
      const failed = new HistoryError(
        'CANCELLED',
        'External source cancellation',
      );
      const entered = Promise.withResolvers<void>();
      const ack = Promise.withResolvers<void>();
      const session = await startRecording(
        {
          ...input.stream,
          acknowledge() {
            entered.resolve();
            return ack.promise;
          },
        },
        store,
        metadata.id,
      );
      if (phase === 'ack') {
        input.next.resolve(transaction('10', '0', '1'));
        await entered.promise;
        ack.reject(failed);
      } else input.next.reject(failed);
      await expect(session.stop()).rejects.toBe(failed);
      expect((await store.info(metadata.id)).status).toBe('interrupted');
    });
  },
);

it('drains an accepted append during stop without acknowledging after closure', async () => {
  await withStore(async (store) => {
    const input = source();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const session = await startRecording(
      input.stream,
      {
        ...store,
        async append(id, value) {
          entered.resolve();
          await release.promise;
          return store.append(id, value);
        },
      },
      metadata.id,
    );
    input.next.resolve(transaction('10', '0', '1'));
    await entered.promise;
    const stopped = session.stop();
    expect((await store.info(metadata.id)).headPosition).toBe('0');
    release.resolve();
    expect(await stopped).toMatchObject({
      status: 'stopped',
      headPosition: '10',
      transactionCount: 1,
    });
    expect(input.acknowledgements).toEqual([]);
    expect(input.closes()).toBe(1);
  });
});

it('retains a persisted commit and reports interruption after acknowledgement failure', async () => {
  await withStore(async (store) => {
    const input = source();
    const failure = new HistoryError(
      'STORAGE_FAILURE',
      'Acknowledgement failed',
    );
    const session = await startRecording(
      {
        ...input.stream,
        async acknowledge() {
          expect((await store.info(metadata.id)).headPosition).toBe('10');
          throw failure;
        },
      },
      store,
      metadata.id,
    );
    input.next.resolve(transaction('10', '0', '1'));
    await expect(session.done).rejects.toBe(failure);
    expect(await store.info(metadata.id)).toMatchObject({
      status: 'interrupted',
      headPosition: '10',
    });
    expect(input.closes()).toBe(1);
  });
});

it('does not hide an append cancellation failure behind a concurrent stop', async () => {
  await withStore(async (store) => {
    const input = source();
    const entered = Promise.withResolvers<void>();
    const append = Promise.withResolvers<'appended'>();
    const failure = new HistoryError('CANCELLED', 'Storage cancelled');
    const session = await startRecording(
      input.stream,
      {
        ...store,
        append() {
          entered.resolve();
          return append.promise;
        },
      },
      metadata.id,
    );
    input.next.resolve(transaction('10', '0', '1'));
    await entered.promise;
    const stopped = session.stop();
    append.reject(failure);
    await expect(stopped).rejects.toBe(failure);
    expect(await store.info(metadata.id)).toMatchObject({
      status: 'interrupted',
      headPosition: '0',
    });
  });
});

it('ends coverage on invalid source data without appending or acknowledging it', async () => {
  await withStore(async (store) => {
    const input = source();
    const session = await startRecording(input.stream, store, metadata.id);
    input.next.resolve({ ...transaction('10', '0', '1'), epochId: 'wrong' });
    await expect(session.done).rejects.toThrow();
    expect(await store.info(metadata.id)).toMatchObject({
      status: 'invalid',
      headPosition: '0',
      transactionCount: 0,
    });
    expect(input.acknowledgements).toEqual([]);
  });
});

it('rejects a source at the wrong durable position without changing lifecycle', async () => {
  await withStore(async (store) => {
    await store.setStatus(metadata.id, 'stopped');
    const input = source();
    await expect(
      startRecording(
        {
          ...input.stream,
          status: () => ({
            state: 'streaming',
            durablePosition: decodePosition('9'),
            receivedPosition: decodePosition('9'),
          }),
        },
        store,
        metadata.id,
      ),
    ).rejects.toThrow('resumable');
    expect((await store.info(metadata.id)).status).toBe('stopped');
    expect(input.closes()).toBe(1);
  });
});

it('preserves source, close and lifecycle persistence errors together', async () => {
  await withStore(async (store) => {
    const input = source();
    const failures = [
      new HistoryError('STORAGE_FAILURE', 'Source failed'),
      new Error('Close failed'),
      new Error('Status failed'),
    ];
    const session = await startRecording(
      {
        ...input.stream,
        async close() {
          await input.stream.close();
          throw failures[1];
        },
      },
      {
        ...store,
        setStatus(id, status) {
          if (status === 'recording') return store.setStatus(id, status);
          throw failures[2];
        },
      },
      metadata.id,
    );
    input.next.reject(failures[0]);
    await expect(session.done).rejects.toMatchObject({
      cause: { errors: failures },
    });
    expect((await store.info(metadata.id)).status).toBe('recording');
  });
});
