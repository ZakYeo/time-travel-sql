import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  openLocalStore,
  createLocalReconstructor,
} from '@time-travel-sql/storage-local';
import {
  resumeRecording,
  decodePosition,
  HistoryError,
} from '@time-travel-sql/sdk';
import type {
  SourceResumeProvider,
  SourceStream,
  CommittedTransaction,
} from '@time-travel-sql/sdk';
import { metadata, transaction } from '../../test-support/storage-fixture.js';

const binding = { adapter: 'custom', version: 1, payload: 'stream' };
function provider() {
  const calls: string[] = [];
  const next = Promise.withResolvers<CommittedTransaction>();
  void next.promise.catch(() => {
    /* Observed by the recorder when it starts. */
  });
  const controller = new AbortController();
  const stream: SourceStream = {
    recording: metadata.recording,
    next: () => next.promise,
    async acknowledge() {},
    status: () => ({
      state: 'streaming',
      durablePosition: decodePosition('0'),
      receivedPosition: decodePosition('0'),
    }),
    async close() {
      calls.push('stream.close');
      next.reject(new HistoryError('CANCELLED', 'Closed'));
    },
  };
  const lease = {
    signal: controller.signal,
    async openStream() {
      calls.push('stream.open');
      return stream;
    },
    async close() {
      calls.push('lease.close');
      controller.abort();
    },
  };
  const source: SourceResumeProvider = {
    async acquire() {
      calls.push('acquire');
      return lease;
    },
  };
  return { source, lease, stream, next, calls };
}
async function withHistory(
  work: (
    store: Awaited<ReturnType<typeof openLocalStore>>,
    reconstructor: ReturnType<typeof createLocalReconstructor>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'tts-resume-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  const reconstructor = createLocalReconstructor({ path });
  try {
    await store.create(metadata);
    await store.bindCapture(metadata.id, binding);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.setStatus(metadata.id, 'stopped');
    await work(store, reconstructor);
  } finally {
    await reconstructor.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

it('acquires before restoration and stop waits for lease release without closing caller storage', async () => {
  await withHistory(async (store, reconstructor) => {
    const input = provider();
    const closing = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const session = await resumeRecording(
      store,
      {
        ...reconstructor,
        open(request, signal) {
          expect(input.calls).toEqual(['acquire']);
          return reconstructor.open(request, signal);
        },
      },
      {
        async acquire() {
          await input.source.acquire(metadata.recording, binding);
          return {
            ...input.lease,
            async close() {
              await input.lease.close();
              entered.resolve();
              await closing.promise;
            },
          };
        },
      },
      metadata.id,
    );
    const stopped = session.stop();
    expect(session.stop()).toBe(stopped);
    await entered.promise;
    expect(input.calls).toEqual([
      'acquire',
      'stream.open',
      'stream.close',
      'lease.close',
    ]);
    expect((await store.info(metadata.id)).status).toBe('stopped');
    closing.resolve();
    expect(await stopped).toEqual(await session.done);
    expect((await store.list({ cursor: null, limit: 10 })).items).toHaveLength(
      1,
    );
  });
});

it('rejects a missing binding before acquiring source ownership', async () => {
  await withHistory(async (store, reconstructor) => {
    const input = provider();
    await expect(
      resumeRecording(
        {
          ...store,
          async captureBinding() {
            return null;
          },
        },
        reconstructor,
        input.source,
        metadata.id,
      ),
    ).rejects.toThrow('no source binding');
    expect(input.calls).toEqual([]);
    expect((await store.info(metadata.id)).status).toBe('stopped');
  });
});

it.each(['acquire', 'restore', 'open'] as const)(
  'cleans partial %s startup and preserves stopped history',
  async (failure) => {
    await withHistory(async (store, reconstructor) => {
      const input = provider();
      const failed = new HistoryError('STORAGE_FAILURE', 'Startup failed');
      await expect(
        resumeRecording(
          store,
          {
            ...reconstructor,
            open(request, signal) {
              if (failure === 'restore') throw failed;
              return reconstructor.open(request, signal);
            },
          },
          {
            async acquire() {
              if (failure === 'acquire') throw failed;
              await input.source.acquire(metadata.recording, binding);
              return {
                ...input.lease,
                openStream() {
                  if (failure === 'open') throw failed;
                  return input.lease.openStream();
                },
              };
            },
          },
          metadata.id,
        ),
      ).rejects.toBe(failed);
      expect(input.calls).toEqual(
        failure === 'acquire' ? [] : ['acquire', 'lease.close'],
      );
      expect((await store.info(metadata.id)).status).toBe('stopped');
    });
  },
);

it('rejects a binding changed during ownership acquisition before opening a stream', async () => {
  await withHistory(async (store, reconstructor) => {
    const input = provider();
    let reads = 0;
    await expect(
      resumeRecording(
        {
          ...store,
          async captureBinding() {
            return ++reads === 1
              ? binding
              : { ...binding, payload: 'replacement' };
          },
        },
        reconstructor,
        input.source,
        metadata.id,
      ),
    ).rejects.toThrow('changed');
    expect(input.calls).toEqual(['acquire', 'lease.close']);
  });
});

it('closes a mismatched opened stream and its lease on recorder startup failure', async () => {
  await withHistory(async (store, reconstructor) => {
    const input = provider();
    await expect(
      resumeRecording(
        store,
        reconstructor,
        {
          async acquire() {
            return {
              ...input.lease,
              async openStream() {
                return {
                  ...input.stream,
                  recording: { ...metadata.recording, epochId: 'wrong' },
                };
              },
            };
          },
        },
        metadata.id,
      ),
    ).rejects.toThrow('resumable');
    expect(input.calls).toEqual(['stream.close', 'lease.close']);
    expect((await store.info(metadata.id)).status).toBe('stopped');
  });
});

it('retains capture and lease cleanup errors in completion', async () => {
  await withHistory(async (store, reconstructor) => {
    const input = provider();
    const failures = [
      new HistoryError('STORAGE_FAILURE', 'Source failed'),
      new Error('Lease close failed'),
    ];
    const session = await resumeRecording(
      store,
      reconstructor,
      {
        async acquire() {
          return {
            ...input.lease,
            async close() {
              await input.lease.close();
              throw failures[1];
            },
          };
        },
      },
      metadata.id,
    );
    input.next.reject(failures[0]);
    await expect(session.done).rejects.toMatchObject({
      cause: { errors: failures },
    });
    expect(input.calls).toEqual(['stream.open', 'stream.close', 'lease.close']);
    expect((await store.info(metadata.id)).status).toBe('interrupted');
  });
});

it.each(['append', 'activation'] as const)(
  'fences delayed old %s after a replacement resumes',
  async (delay) => {
    await withHistory(async (store, reconstructor) => {
      const old = provider();
      const replacement = provider();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const delayedStore = {
        ...store,
        async prepareRecording(id: string) {
          const claim = await store.prepareRecording(id);
          return {
            recordingId: id,
            async activate() {
              if (delay === 'activation') {
                entered.resolve();
                await release.promise;
              }
              const writer = await claim.activate();
              return {
                ...writer,
                async append(key: string, tx: CommittedTransaction) {
                  entered.resolve();
                  await release.promise;
                  return writer.append(key, tx);
                },
              };
            },
          };
        },
      };
      const starting = resumeRecording(
        delayedStore,
        reconstructor,
        old.source,
        metadata.id,
      );
      void starting.catch(() => {
        /* Failure asserted below. */
      });
      const previous = delay === 'append' ? await starting : undefined;
      if (previous) old.next.resolve(transaction('10', '0', '1'));
      await entered.promise;
      await old.lease.close();
      const current = await resumeRecording(
        store,
        reconstructor,
        replacement.source,
        metadata.id,
      );
      try {
        release.resolve();
        await expect(previous ? previous.done : starting).rejects.toThrow();
        expect((await store.info(metadata.id)).status).toBe('recording');
        expect((await store.info(metadata.id)).headPosition).toBe('0');
      } finally {
        release.resolve();
        await current.stop();
      }
    });
  },
);
