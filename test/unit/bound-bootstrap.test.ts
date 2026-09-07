import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openLocalStore } from '@time-travel-sql/storage-local';
import { bootstrapBoundRecording, decodePosition } from '@time-travel-sql/sdk';
import type { SourceBaseline } from '@time-travel-sql/sdk';
import { metadata, row } from '../../test-support/storage-fixture.js';

const request = {
  id: metadata.id,
  name: metadata.name,
  createdAt: metadata.createdAt,
};
const binding = { adapter: 'custom', version: 1, payload: 'stream' };
const baseline = (): SourceBaseline => ({
  recording: metadata.recording,
  position: decodePosition('10'),
  async next() {
    return null;
  },
  async close() {},
});

async function withStore(
  work: (store: Awaited<ReturnType<typeof openLocalStore>>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'tts-bound-bootstrap-'));
  const store = await openLocalStore({ path: join(root, 'history.sqlite') });
  try {
    await work(store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

it('persists metadata and binding before opening and publishes only after close', async () => {
  await withStore(async (store) => {
    let closed = false;
    let sent = false;
    const result = await bootstrapBoundRecording(
      {
        recording: metadata.recording,
        binding,
        async openBaseline() {
          expect(await store.captureBinding(metadata.id)).toEqual(binding);
          expect((await store.info(metadata.id)).status).toBe('bootstrapping');
          return {
            ...baseline(),
            async next() {
              if (sent) return null;
              sent = true;
              return [row('1')];
            },
            async close() {
              closed = true;
              expect(
                (await store.info(metadata.id)).baselinePosition,
              ).toBeNull();
            },
          };
        },
      },
      store,
      request,
    );
    expect(closed).toBe(true);
    expect(result).toMatchObject({
      status: 'recording',
      baselineRowCount: 1,
      baselinePosition: '10',
    });
  });
});

it.each(['binding', 'open', 'schema'] as const)(
  'invalidates failed %s bootstrap without publishing rows',
  async (failure) => {
    await withStore(async (store) => {
      let opened = false;
      let closed = false;
      await expect(
        bootstrapBoundRecording(
          {
            recording: metadata.recording,
            binding,
            async openBaseline() {
              opened = true;
              if (failure === 'open') throw new Error('open failed');
              return {
                ...baseline(),
                recording: { ...metadata.recording, epochId: 'wrong' },
                async close() {
                  closed = true;
                },
              };
            },
          },
          {
            ...store,
            async bindCapture(id, value) {
              if (failure === 'binding') throw new Error('binding failed');
              await store.bindCapture(id, value);
            },
          },
          request,
        ),
      ).rejects.toThrow();
      expect(opened).toBe(failure !== 'binding');
      expect(closed).toBe(failure === 'schema');
      expect(await store.info(metadata.id)).toMatchObject({
        status: 'invalid',
        baselinePosition: null,
        headPosition: null,
      });
      expect(await store.captureBinding(metadata.id)).toEqual(
        failure === 'binding' ? null : binding,
      );
    });
  },
);

it('does not open a source or invalidate an existing recording on duplicate creation', async () => {
  await withStore(async (store) => {
    await store.create(metadata);
    const before = await store.publishBaseline(
      metadata.id,
      decodePosition('0'),
    );
    let opened = false;
    await expect(
      bootstrapBoundRecording(
        {
          recording: metadata.recording,
          binding,
          async openBaseline() {
            opened = true;
            return baseline();
          },
        },
        store,
        request,
      ),
    ).rejects.toThrow();
    expect(opened).toBe(false);
    expect(await store.info(metadata.id)).toEqual(before);
  });
});

it('rejects malformed plans before creating metadata or opening a source', async () => {
  await withStore(async (store) => {
    let opened = false;
    await expect(
      bootstrapBoundRecording(
        {
          recording: metadata.recording,
          binding: { ...binding, version: 0 },
          async openBaseline() {
            opened = true;
            return baseline();
          },
        },
        store,
        request,
      ),
    ).rejects.toThrow();
    expect(opened).toBe(false);
    expect((await store.list({ cursor: null, limit: 10 })).items).toEqual([]);
  });
});
