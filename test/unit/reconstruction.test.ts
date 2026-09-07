import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  createLocalReconstructor,
  openLocalStore,
} from '@time-travel-sql/storage-local';
import {
  decodePosition,
  decodeSelection,
  decodeTransaction,
} from '@time-travel-sql/sdk';
import {
  metadata,
  row,
  transaction,
} from '../../test-support/storage-fixture.js';

it('opens baseline, before and after states without publishing checkpoints or changing progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-reconstruct-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  const reader = createLocalReconstructor({ path });
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('1')]);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.append(metadata.id, transaction('10', '0', '2'));
    await store.append(metadata.id, transaction('20', '10', '3'));
    for (const [selection, position, expected] of [
      [decodeSelection({ kind: 'baseline' }), '0', ['1']],
      [decodeSelection({ kind: 'before', position: '20' }), '10', ['1', '2']],
      [
        decodeSelection({ kind: 'after', position: '20' }),
        '20',
        ['1', '2', '3'],
      ],
    ] as const) {
      const session = await reader.open({
        recordingId: metadata.id,
        selection,
      });
      try {
        expect(session.info.position).toBe(position);
        expect(session.info.rowCount).toBe(expected.length);
        expect(Object.isFrozen(session.info)).toBe(true);
        const actual = [];
        let cursor: string | null = null;
        do {
          const page = await session.rows('orders', { cursor, limit: 1 });
          actual.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== null);
        expect(actual).toEqual(expected.map((value) => row(value).row));
        await expect(
          session.rows('missing', { cursor: null, limit: 1 }),
        ).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
        await expect(
          session.rows('orders', { cursor: '999', limit: 1 }),
        ).rejects.toThrow('cursor');
      } finally {
        await session.close();
      }
    }
    expect(
      (await store.checkpoints(metadata.id, { cursor: null, limit: 100 }))
        .items,
    ).toEqual([]);
    expect(await store.info(metadata.id)).toMatchObject({
      headPosition: '20',
      transactionCount: 2,
    });
  } finally {
    await reader.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('retains a stable selected state after append and deletion, without retaining a WAL read transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-reconstruct-stable-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  const reader = createLocalReconstructor({ path });
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('1')]);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    const session = await reader.open({
      recordingId: metadata.id,
      selection: decodeSelection({ kind: 'baseline' }),
    });
    await store.append(metadata.id, transaction('10', '0', '2'));
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()).toMatchObject(
        { busy: 0, log: 0 },
      );
    } finally {
      db.close();
    }
    await store.remove(metadata.id);
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('9')]);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    expect(
      (await session.rows('orders', { cursor: null, limit: 100 })).items,
    ).toEqual([row('1').row]);
    expect(session.info.recording.headPosition).toBe('0');
    const fresh = await reader.open({
      recordingId: metadata.id,
      selection: decodeSelection({ kind: 'baseline' }),
    });
    expect(
      (await fresh.rows('orders', { cursor: null, limit: 100 })).items,
    ).toEqual([row('9').row]);
    await fresh.close();
    await session.close();
  } finally {
    await reader.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('uses a valid checkpoint under a smaller state budget and releases capacity after failed opens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-reconstruct-checkpoint-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  const reader = createLocalReconstructor({
    path,
    maxConcurrent: 1,
    replayLimits: { maxRows: 1, maxBytes: 10000 },
  });
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('1'), row('2')]);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.append(
      metadata.id,
      decodeTransaction(metadata.recording, {
        ...transaction('10', '0', '1'),
        events: [{ kind: 'delete', tableId: 'orders', before: row('2').row }],
      }),
    );
    await store.publishCheckpoint(
      metadata.id,
      decodeSelection({ kind: 'after', position: '10' }),
    );
    await expect(
      reader.open({
        recordingId: metadata.id,
        selection: decodeSelection({ kind: 'baseline' }),
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const session = await reader.open({
      recordingId: metadata.id,
      selection: decodeSelection({ kind: 'after', position: '10' }),
    });
    expect(
      (await session.rows('orders', { cursor: null, limit: 100 })).items,
    ).toEqual([row('1').row]);
    await session.close();
  } finally {
    await reader.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not create a missing recording database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-reconstruct-missing-'));
  const path = join(root, 'missing.sqlite');
  const reader = createLocalReconstructor({ path });
  try {
    await expect(
      reader.open({
        recordingId: metadata.id,
        selection: decodeSelection({ kind: 'baseline' }),
      }),
    ).rejects.toThrow();
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});
