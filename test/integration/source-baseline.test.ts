import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { openLocalStore } from '@time-travel-sql/storage-local';
import {
  bootstrapRecording,
  HistoryState,
  recordNextCommit,
} from '@time-travel-sql/sdk';
import {
  openPostgresBaseline,
  openPostgresStream,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';

it('publishes the consistent baseline and records a commit made during snapshot capture through public APIs', async () => {
  await withPostgres(async (connection) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-baseline-'));
    const store = await openLocalStore({ path: join(root, 'history.sqlite') });
    const writer = new pg.Client(connection);
    await writer.connect();
    try {
      await writer.query(`CREATE TABLE items (id integer PRIMARY KEY, value integer);
        ALTER TABLE items REPLICA IDENTITY FULL;
        INSERT INTO items VALUES (1, 0), (2, 0);
        CREATE PUBLICATION tts_baseline FOR TABLE items`);
      const source = await openPostgresBaseline({
        connection,
        slot: 'tts_baseline',
        tables: [{ namespace: 'public', name: 'items' }],
        sourceId: 'source',
        epochId: 'epoch',
        schemaId: 'schema',
        batchSize: 1,
        signal: new AbortController().signal,
      });
      try {
        await writer.query(
          'BEGIN; UPDATE items SET value=1 WHERE id=1; INSERT INTO items VALUES(3, 1); COMMIT',
        );
        const info = await bootstrapRecording(source, store, {
          id: 'recording',
          name: 'Items',
          createdAt: '2026-01-01 00:00:00Z',
        });
        expect(info.baselineRowCount).toBe(2);
        const rows = (
          await store.baseline(info.id, { cursor: null, limit: 100 })
        ).items;
        expect(
          rows.map((entry) =>
            entry.row.map((value) =>
              value.kind === 'scalar' ? value.value : null,
            ),
          ),
        ).toEqual([
          ['1', '0'],
          ['2', '0'],
        ]);
        const state = HistoryState.fromSnapshot(
          info.recording,
          source.position,
          rows,
        );
        const stream = await openPostgresStream({
          connection,
          slot: 'tts_baseline',
          publication: 'tts_baseline',
          systemId: source.systemId,
          timeline: source.timeline,
          databaseOid: source.databaseOid,
          state,
          signal: new AbortController().signal,
        });
        try {
          const commit = await recordNextCommit(stream, store, info.id);
          expect(commit.events.map((event) => event.kind)).toEqual([
            'update',
            'insert',
          ]);
          expect(state.apply(commit).rowCount).toBe(3);
          expect((await store.info(info.id)).transactionCount).toBe(1);
        } finally {
          await stream.close();
        }
      } finally {
        await source.close();
      }
    } finally {
      await writer.end();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it.each(['idle', 'pending', 'aborted'])(
  'closes a baseline in state %s without dropping its persistent slot',
  async (state) => {
    await withPostgres(async (connection) => {
      const writer = new pg.Client(connection);
      await writer.connect();
      try {
        await writer.query(
          'CREATE TABLE items(id integer PRIMARY KEY); ALTER TABLE items REPLICA IDENTITY FULL',
        );
        const controller = new AbortController();
        const source = await openPostgresBaseline({
          connection,
          slot: 'tts_baseline',
          tables: [{ namespace: 'public', name: 'items' }],
          sourceId: 'source',
          epochId: 'epoch',
          schemaId: 'schema',
          signal: controller.signal,
        });
        if (state === 'aborted') controller.abort();
        const pending =
          state === 'pending'
            ? expect(source.next()).rejects.toMatchObject({ code: 'CANCELLED' })
            : undefined;
        await source.close();
        await pending;
        await source.close();
        await expect(source.next()).rejects.toMatchObject({
          code: 'CANCELLED',
        });
        expect(
          (
            await writer.query(
              "SELECT active FROM pg_replication_slots WHERE slot_name='tts_baseline'",
            )
          ).rows,
        ).toEqual([{ active: false }]);
      } finally {
        await writer.end();
      }
    });
  },
);

it('keeps near-limit canonical rows within the public batch byte bound', async () => {
  await withPostgres(async (connection) => {
    const writer = new pg.Client(connection);
    await writer.connect();
    try {
      await writer.query(`CREATE TABLE items(id integer PRIMARY KEY, payload text);
        ALTER TABLE items REPLICA IDENTITY FULL;
        INSERT INTO items SELECT i, repeat('x', 1048487) FROM generate_series(1,16) AS i`);
      const source = await openPostgresBaseline({
        connection,
        slot: 'tts_baseline',
        tables: [{ namespace: 'public', name: 'items' }],
        sourceId: 'source',
        epochId: 'epoch',
        schemaId: 'schema',
        batchSize: 16,
        signal: new AbortController().signal,
      });
      try {
        let count = 0;
        let batches = 0;
        while (true) {
          const rows = await source.next();
          if (rows === null) break;
          count += rows.length;
          batches++;
          expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(
            16 * 1024 * 1024,
          );
        }
        expect(count).toBe(16);
        expect(batches).toBe(2);
      } finally {
        await source.close();
      }
    } finally {
      await writer.end();
    }
  });
});
