import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openLocalStore } from '@time-travel-sql/storage-local';
import {
  decodePosition,
  decodeSelection,
  decodeTransaction,
  decodeRecordingMetadata,
  scalarValue,
} from '@time-travel-sql/sdk';
import type { RowEvent } from '@time-travel-sql/sdk';
import {
  metadata,
  row,
  transaction,
} from '../../test-support/storage-fixture.js';

const commit = (
  position: string,
  previousPosition: string,
  events: readonly RowEvent[],
) =>
  decodeTransaction(metadata.recording, {
    ...transaction(position, previousPosition, '1'),
    events,
  });

it('does not publish a partial checkpoint when SQLite runs out of allowed pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-checkpoint-full-'));
  const path = join(root, 'history.sqlite');
  let store = await openLocalStore({ path });
  const sourceTable = metadata.recording.schema.tables[0];
  if (!sourceTable) throw new Error('Missing fixture table');
  const recording = decodeRecordingMetadata({
    ...metadata,
    recording: {
      ...metadata.recording,
      schema: {
        ...metadata.recording.schema,
        tables: [
          {
            ...sourceTable,
            columns: [
              ...sourceTable.columns,
              { name: 'note', type: 'text', nullable: false, typeModifier: -1 },
            ],
          },
        ],
      },
    },
  });
  try {
    await store.create(recording);
    await store.stageBaseline(metadata.id, [
      {
        tableId: 'orders',
        row: [scalarValue('int4', '1'), scalarValue('text', 'x'.repeat(40000))],
      },
    ]);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.close();
    const size = (await stat(path)).size;
    store = await openLocalStore({ path, maxBytes: size + 4096 });
    await expect(
      store.publishCheckpoint(
        metadata.id,
        decodeSelection({ kind: 'baseline' }),
      ),
    ).rejects.toThrow();
    expect(
      (await store.checkpoints(metadata.id, { cursor: null, limit: 100 }))
        .items,
    ).toEqual([]);
    expect(await store.info(metadata.id)).toMatchObject({
      baselineRowCount: 1,
      headPosition: '0',
      transactionCount: 0,
    });
    const db = new DatabaseSync(path);
    try {
      expect(
        db.prepare('SELECT count(*) AS n FROM checkpoint_rows').get()?.n,
      ).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('publishes exact baseline, before and after checkpoints without changing recording progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-checkpoints-'));
  const store = await openLocalStore({ path: join(root, 'history.sqlite') });
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('1')]);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.append(metadata.id, transaction('10', '0', '2'));
    await store.append(
      metadata.id,
      commit('20', '10', [
        {
          kind: 'update',
          tableId: 'orders',
          before: row('1').row,
          after: row('3').row,
        },
      ]),
    );
    const initial = await store.publishCheckpoint(
      metadata.id,
      decodeSelection({ kind: 'baseline' }),
    );
    const before = await store.publishCheckpoint(
      metadata.id,
      decodeSelection({ kind: 'before', position: '20' }),
    );
    const after = await store.publishCheckpoint(
      metadata.id,
      decodeSelection({ kind: 'after', position: '20' }),
    );
    expect([initial.position, before.position, after.position]).toEqual([
      '0',
      '10',
      '20',
    ]);
    expect([initial.rowCount, before.rowCount, after.rowCount]).toEqual([
      1, 2, 2,
    ]);
    const values = [];
    let cursor: string | null = null;
    do {
      const page = await store.checkpointRows(metadata.id, after.position, {
        cursor,
        limit: 1,
      });
      values.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(values).toEqual([row('2'), row('3')]);
    expect(
      (
        await store.checkpoints(metadata.id, { cursor: null, limit: 100 })
      ).items.map((checkpoint) => checkpoint.transactionCount),
    ).toEqual([0, 1, 2]);
    expect(await store.info(metadata.id)).toMatchObject({
      headPosition: '20',
      transactionCount: 2,
    });
    await expect(
      store.publishCheckpoint(
        metadata.id,
        decodeSelection({ kind: 'after', position: '15' }),
      ),
    ).rejects.toThrow();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('restores from the latest valid checkpoint and replays only its suffix after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-checkpoint-restart-'));
  const path = join(root, 'history.sqlite');
  let store = await openLocalStore({ path });
  const update = commit('30', '20', [
    {
      kind: 'update',
      tableId: 'orders',
      before: row('3').row,
      after: row('4').row,
    },
  ]);
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('1'), row('2')]);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.append(
      metadata.id,
      commit('10', '0', [
        { kind: 'delete', tableId: 'orders', before: row('2').row },
      ]),
    );
    await store.publishCheckpoint(
      metadata.id,
      decodeSelection({ kind: 'after', position: '10' }),
    );
    await store.append(
      metadata.id,
      commit('20', '10', [
        {
          kind: 'update',
          tableId: 'orders',
          before: row('1').row,
          after: row('3').row,
        },
      ]),
    );
    await store.publishCheckpoint(
      metadata.id,
      decodeSelection({ kind: 'after', position: '20' }),
    );
    await store.close();
    const db = new DatabaseSync(path);
    try {
      db.prepare('DELETE FROM checkpoint_rows WHERE position=?').run(
        '20'.padStart(40, '0'),
      );
    } finally {
      db.close();
    }
    // The baseline has two rows and cannot be materialized under this budget.
    // The older valid checkpoint has one row, proving fallback uses it and the suffix.
    store = await openLocalStore({
      path,
      replayLimits: { maxRows: 1, maxBytes: 10000 },
    });
    await expect(store.append(metadata.id, update)).resolves.toBe('appended');
    expect((await store.info(metadata.id)).headPosition).toBe('30');
    await store.removeCheckpoint(metadata.id, decodePosition('10'));
    await store.removeCheckpoint(metadata.id, decodePosition('20'));
    await store.close();
    store = await openLocalStore({
      path,
      replayLimits: { maxRows: 1, maxBytes: 10000 },
    });
    await expect(
      store.append(metadata.id, transaction('40', '30', '5')),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect((await store.info(metadata.id)).headPosition).toBe('30');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('never uses a checkpoint to hide corruption of authoritative history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-checkpoint-authority-'));
  const path = join(root, 'history.sqlite');
  let store = await openLocalStore({ path });
  try {
    await store.create(metadata);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.append(metadata.id, transaction('10', '0', '1'));
    await store.publishCheckpoint(
      metadata.id,
      decodeSelection({ kind: 'after', position: '10' }),
    );
    await store.close();
    const db = new DatabaseSync(path);
    try {
      db.exec("UPDATE transactions SET data='{}'");
    } finally {
      db.close();
    }
    store = await openLocalStore({ path });
    await expect(
      store.append(metadata.id, transaction('20', '10', '2')),
    ).rejects.toThrow('integrity');
    expect((await store.info(metadata.id)).headPosition).toBe('10');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('migrates an intact version-1 database transactionally without changing its recordings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-migration-'));
  const path = join(root, 'history.sqlite');
  let store = await openLocalStore({ path });
  try {
    await store.create(metadata);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.close();
    const db = new DatabaseSync(path);
    try {
      db.exec(
        'DROP TABLE capture_bindings; DROP TABLE checkpoint_rows; DROP TABLE checkpoints; PRAGMA user_version=1',
      );
    } finally {
      db.close();
    }
    store = await openLocalStore({ path });
    expect((await store.info(metadata.id)).headPosition).toBe('0');
    expect(
      (
        await store.publishCheckpoint(
          metadata.id,
          decodeSelection({ kind: 'baseline' }),
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
