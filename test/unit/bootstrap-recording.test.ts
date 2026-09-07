import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openLocalStore } from '@time-travel-sql/storage-local';
import { bootstrapRecording, decodePosition } from '@time-travel-sql/sdk';
import type { SourceBaseline, SnapshotRow } from '@time-travel-sql/sdk';
import { metadata, row } from '../../test-support/storage-fixture.js';

const request = {
  id: metadata.id,
  name: metadata.name,
  createdAt: metadata.createdAt,
};
function source(batches: (readonly SnapshotRow[] | Error)[]): SourceBaseline {
  return {
    recording: metadata.recording,
    position: decodePosition('10'),
    async next() {
      const batch = batches.shift();
      if (batch instanceof Error) throw batch;
      return batch ?? null;
    },
    async close() {},
  };
}

async function withStore(
  work: (store: Awaited<ReturnType<typeof openLocalStore>>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'tts-bootstrap-'));
  const store = await openLocalStore({ path: join(root, 'history.sqlite') });
  try {
    await work(store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

it('keeps staged rows unpublished until source completion and successful close', async () => {
  await withStore(async (store) => {
    const closing = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const capture = bootstrapRecording(
      {
        ...source([[row('1')], [row('2')]]),
        close() {
          entered.resolve();
          return closing.promise;
        },
      },
      store,
      request,
    );
    await entered.promise;
    expect((await store.info(metadata.id)).status).toBe('bootstrapping');
    await expect(
      store.baseline(metadata.id, { cursor: null, limit: 10 }),
    ).rejects.toThrow();
    closing.resolve();
    expect(await capture).toMatchObject({
      status: 'recording',
      baselinePosition: '10',
      baselineRowCount: 2,
    });
  });
});

it.each(['source', 'duplicate', 'empty', 'limit', 'close'] as const)(
  'leaves an invalid unpublished artifact after %s failure',
  async (failure) => {
    await withStore(async (store) => {
      const batches =
        failure === 'source'
          ? [[row('1')], new Error('source failure')]
          : failure === 'duplicate'
            ? [[row('1')], [row('1')]]
            : failure === 'empty'
              ? [[]]
              : [[row('1')], [row('2')]];
      const baseline = source(batches);
      await expect(
        bootstrapRecording(
          {
            ...baseline,
            async close() {
              if (failure === 'close') throw new Error('close failure');
            },
          },
          store,
          request,
          { maxRows: failure === 'limit' ? 1 : 100, maxBytes: 100000 },
        ),
      ).rejects.toThrow();
      expect(await store.info(metadata.id)).toMatchObject({
        status: 'invalid',
        baselinePosition: null,
        headPosition: null,
      });
      await expect(
        store.publishBaseline(metadata.id, decodePosition('10')),
      ).rejects.toThrow();
    });
  },
);

it('does not invalidate an existing recording when creation is rejected', async () => {
  await withStore(async (store) => {
    await bootstrapRecording(source([]), store, request);
    let closed = false;
    await expect(
      bootstrapRecording(
        {
          ...source([]),
          async close() {
            closed = true;
          },
        },
        store,
        request,
      ),
    ).rejects.toThrow();
    expect(closed).toBe(true);
    expect((await store.info(metadata.id)).status).toBe('recording');
  });
});

it('preserves capture, source cleanup and invalidation failures together', async () => {
  await withStore(async (store) => {
    const failures = [
      new Error('capture'),
      new Error('close'),
      new Error('invalidation'),
    ];
    await expect(
      bootstrapRecording(
        {
          ...source([]),
          async next() {
            throw failures[0];
          },
          async close() {
            throw failures[1];
          },
        },
        {
          create: (value) => store.create(value),
          stageBaseline: (id, rows) => store.stageBaseline(id, rows),
          publishBaseline: (id, position) =>
            store.publishBaseline(id, position),
          async setStatus() {
            throw failures[2];
          },
        },
        request,
      ),
    ).rejects.toMatchObject({ cause: { errors: failures } });
    expect((await store.info(metadata.id)).status).toBe('bootstrapping');
  });
});
