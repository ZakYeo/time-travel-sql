import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openLocalStore } from '@time-travel-sql/storage-local';
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

const update = (
  position: string,
  previous: string,
  before: string,
  after: string,
) =>
  decodeTransaction(metadata.recording, {
    ...transaction(position, previous, after),
    events: [
      {
        kind: 'update',
        tableId: 'orders',
        before: row(before).row,
        after: row(after).row,
      },
    ],
  });

it('rejects same-count checkpoint row replacement through the public reader after a cached read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-checkpoint-read-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('1')]);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.publishCheckpoint(
      metadata.id,
      decodeSelection({ kind: 'baseline' }),
    );
    await store.append(metadata.id, update('10', '0', '1', '2'));
    await store.publishCheckpoint(
      metadata.id,
      decodeSelection({ kind: 'after', position: '10' }),
    );
    expect(
      (
        await store.checkpointRows(metadata.id, decodePosition('10'), {
          cursor: null,
          limit: 100,
        })
      ).items,
    ).toEqual([row('2')]);
    const db = new DatabaseSync(path);
    try {
      db.prepare('DELETE FROM checkpoint_rows WHERE position=?').run(
        '10'.padStart(40, '0'),
      );
      db.prepare(
        'INSERT INTO checkpoint_rows SELECT recording_id,?,key,data,digest FROM checkpoint_rows WHERE position=?',
      ).run('10'.padStart(40, '0'), '0'.padStart(40, '0'));
    } finally {
      db.close();
    }
    await expect(
      store.checkpointRows(metadata.id, decodePosition('10'), {
        cursor: null,
        limit: 100,
      }),
    ).rejects.toThrow('completeness');
    await expect(
      store.append(metadata.id, update('20', '10', '2', '3')),
    ).resolves.toBe('appended');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('finds an older valid checkpoint beyond 100 damaged candidates, and reports actual budget exhaustion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-checkpoint-candidates-'));
  const path = join(root, 'history.sqlite');
  let store = await openLocalStore({ path });
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
    await store.append(metadata.id, update('10000', '10', '1', '3'));
    await store.close();
    const damage = (count: number) => {
      const db = new DatabaseSync(path);
      try {
        db.exec('BEGIN IMMEDIATE');
        const insert = db.prepare(
          'INSERT OR REPLACE INTO checkpoints(recording_id,position,data,digest) VALUES(?,?,?,?)',
        );
        for (let index = 0; index < count; index++)
          insert.run(
            metadata.id,
            String(index + 100).padStart(40, '0'),
            '{}',
            'damaged',
          );
        db.exec('COMMIT');
      } finally {
        db.close();
      }
    };
    damage(101);
    store = await openLocalStore({
      path,
      replayLimits: { maxRows: 1, maxBytes: 10000 },
    });
    await expect(
      store.append(metadata.id, update('10001', '10000', '3', '4')),
    ).resolves.toBe('appended');
    damage(1001);
    await expect(
      store.append(metadata.id, update('10002', '10001', '4', '5')),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect((await store.info(metadata.id)).headPosition).toBe('10001');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
