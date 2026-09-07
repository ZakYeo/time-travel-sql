import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  openLocalStore,
  createLocalReconstructor,
} from '@time-travel-sql/storage-local';
import {
  restoreRecordingHead,
  decodePosition,
  HistoryError,
} from '@time-travel-sql/sdk';
import type { Page, Row } from '@time-travel-sql/sdk';
import {
  metadata,
  row,
  transaction,
} from '../../test-support/storage-fixture.js';

async function withHistory(
  work: (
    store: Awaited<ReturnType<typeof openLocalStore>>,
    reconstructor: ReturnType<typeof createLocalReconstructor>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'tts-restore-head-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  const reconstructor = createLocalReconstructor({ path });
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('1')]);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await work(store, reconstructor);
  } finally {
    await reconstructor.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

it('restores the baseline and a checkpoint-backed head with last-commit idempotence', async () => {
  await withHistory(async (store, reconstructor) => {
    const baseline = await restoreRecordingHead(
      store,
      reconstructor,
      metadata.id,
    );
    expect(baseline.state.position).toBe('0');
    expect(baseline.state.rows('orders')).toEqual([row('1').row]);
    await store.append(metadata.id, transaction('10', '0', '2'));
    await store.publishCheckpoint(metadata.id, {
      kind: 'after',
      position: decodePosition('10'),
    });
    const last = transaction('20', '10', '3');
    await store.append(metadata.id, last);
    await store.setStatus(metadata.id, 'stopped');
    const restored = await restoreRecordingHead(
      store,
      reconstructor,
      metadata.id,
    );
    expect(restored.info).toEqual(await store.info(metadata.id));
    expect(restored.state.position).toBe('20');
    expect(restored.state.rows('orders')).toEqual(
      ['1', '2', '3'].map((value) => row(value).row),
    );
    expect(restored.state.apply(last)).toBe(restored.state);
  });
});

it('rejects invalid coverage before opening a reconstruction', async () => {
  await withHistory(async (store, reconstructor) => {
    await store.setStatus(metadata.id, 'invalid');
    let opened = false;
    await expect(
      restoreRecordingHead(
        store,
        {
          ...reconstructor,
          async open(request) {
            opened = true;
            return reconstructor.open(request);
          },
        },
        metadata.id,
      ),
    ).rejects.toThrow('resumable');
    expect(opened).toBe(false);
  });
});

it('detects metadata changes during restoration and closes the owned session', async () => {
  await withHistory(async (store, reconstructor) => {
    let closed = 0;
    await expect(
      restoreRecordingHead(
        store,
        {
          ...reconstructor,
          async open(request) {
            const session = await reconstructor.open(request);
            return {
              ...session,
              async rows(table, page) {
                await store.rename(metadata.id, 'Renamed concurrently');
                return session.rows(table, page);
              },
              async close() {
                closed++;
                await session.close();
              },
            };
          },
        },
        metadata.id,
      ),
    ).rejects.toThrow('changed');
    expect(closed).toBe(1);
  });
});

it('rejects inconsistent reconstructed row counts and closes once', async () => {
  await withHistory(async (store, reconstructor) => {
    let closed = 0;
    await expect(
      restoreRecordingHead(
        store,
        {
          ...reconstructor,
          async open(request) {
            const session = await reconstructor.open(request);
            return {
              ...session,
              async rows() {
                return { items: [], nextCursor: null };
              },
              async close() {
                closed++;
                await session.close();
              },
            };
          },
        },
        metadata.id,
      ),
    ).rejects.toThrow('declared state size');
    expect(closed).toBe(1);
  });
});

it('cancels pending paging and does not expose a partial state', async () => {
  await withHistory(async (store, reconstructor) => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Page<Row>>();
    let closed = 0;
    const restoring = restoreRecordingHead(
      store,
      {
        ...reconstructor,
        async open(request) {
          const session = await reconstructor.open(request);
          return {
            ...session,
            rows() {
              entered.resolve();
              return pending.promise;
            },
            async close() {
              closed++;
              pending.reject(new HistoryError('CANCELLED', 'Closed'));
              await session.close();
            },
          };
        },
      },
      metadata.id,
      controller.signal,
    );
    await entered.promise;
    controller.abort();
    await expect(restoring).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(closed).toBe(1);
  });
});

it('retains both paging and cleanup failures', async () => {
  await withHistory(async (store, reconstructor) => {
    const failures = [new Error('Page failed'), new Error('Close failed')];
    await expect(
      restoreRecordingHead(
        store,
        {
          ...reconstructor,
          async open(request) {
            const session = await reconstructor.open(request);
            return {
              ...session,
              async rows() {
                throw failures[0];
              },
              async close() {
                await session.close();
                throw failures[1];
              },
            };
          },
        },
        metadata.id,
      ),
    ).rejects.toMatchObject({ cause: { errors: failures } });
  });
});
