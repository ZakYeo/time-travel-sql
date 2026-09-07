import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLocalStore } from '@time-travel-sql/storage-local';
import pg from 'pg';
import { LogicalReplicationService } from 'pg-logical-replication';
import { expect, it } from 'vitest';
import {
  decodeRecordingSchema,
  decodeRecordingMetadata,
  decodePosition,
  HistoryState,
  rowKey,
} from '@time-travel-sql/sdk';
import type { RecordingSchema, Row } from '@time-travel-sql/sdk';
import {
  readSnapshot,
  postgresSchema,
  postgresRow,
  postgresChange,
  PgoutputFrame,
  ExactPgoutputPlugin,
  encodeLsn,
  decodeLsn,
  PostgresTransactions,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';

it('normalizes real TOAST updates, repeated changes and key changes from recorded state', async () => {
  await withPostgres(async (connection) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-commit-ack-'));
    const path = join(root, 'history.sqlite');
    let store = await openLocalStore({ path });
    const writer = new pg.Client(connection);
    const stream = new LogicalReplicationService(connection, {
      acknowledge: { auto: false, timeoutSeconds: 0 },
      flowControl: { enabled: true },
    });
    const completion = Promise.withResolvers<void>();
    const observed = completion.promise.catch((error: unknown) => error);
    const deadline = AbortSignal.timeout(15000);
    const abort = () =>
      completion.reject(new Error('Replication deadline exceeded'));
    deadline.addEventListener('abort', abort, { once: true });
    const frames: PgoutputFrame[] = [];
    stream.on('error', (error) => completion.reject(error));
    stream.on('data', (_lsn: string, input: unknown) => {
      if (!(input instanceof PgoutputFrame)) {
        completion.reject(new Error('Invalid frame'));
        return;
      }
      if (input.result.kind === 'error') {
        completion.reject(input.result.error);
        return;
      }
      frames.push(input);
      if (input.result.message.tag === 'commit') completion.resolve();
    });
    let subscription: Promise<unknown> | undefined;
    await writer.connect();
    try {
      await writer.query(`CREATE TABLE toasted (id bigint PRIMARY KEY, body text, count integer);
        ALTER TABLE toasted REPLICA IDENTITY FULL;
        ALTER TABLE toasted ALTER COLUMN body SET STORAGE EXTERNAL;
        INSERT INTO toasted SELECT 9007199254740993, string_agg(md5(i::text), ''), 1 FROM generate_series(1,1000) i;
        CREATE PUBLICATION tts_toasted FOR TABLE toasted`);
      const rows = new Map<string, Row>();
      let recording: RecordingSchema | undefined;
      let lsn: string | undefined;
      let body: string | undefined;
      for await (const part of readSnapshot({
        connection,
        slot: 'tts_toasted',
        tables: [{ namespace: 'public', name: 'toasted' }],
        signal: deadline,
      })) {
        if (part.kind === 'begin') {
          lsn = encodeLsn(part.position);
          recording = decodeRecordingSchema({
            sourceId: 'source',
            epochId: 'epoch',
            schema: postgresSchema('schema', part.tables),
          });
        } else if (part.kind === 'rows') {
          const table = recording?.schema.tables[0];
          if (!table || !recording) throw new Error('Missing schema');
          for (const raw of part.rows) {
            const row = postgresRow(table, raw);
            rows.set(rowKey(recording, table, row), row);
            body = raw[1] ?? undefined;
          }
        }
      }
      if (!recording || !lsn || !body) throw new Error('Missing snapshot');
      expect(body).toHaveLength(32000);
      const tableId = recording.schema.tables[0]?.id;
      if (!tableId) throw new Error('Missing table');
      const snapshot = [...rows.values()].map((row) => ({ tableId, row }));
      const assembler = new PostgresTransactions(
        HistoryState.fromSnapshot(recording, decodeLsn(lsn), snapshot),
      );
      await store.create(
        decodeRecordingMetadata({
          id: 'recording',
          name: 'TOAST history',
          createdAt: '2026-01-01 00:00:00Z',
          recording,
        }),
      );
      await store.stageBaseline('recording', snapshot);
      await store.publishBaseline('recording', decodeLsn(lsn));
      const beforeCommit = BigInt(Date.now()) * 1000n;
      await writer.query(`BEGIN; UPDATE toasted SET count=2;
        UPDATE toasted SET id=9007199254740994, count=3;
        DELETE FROM toasted; INSERT INTO toasted VALUES (7, NULL, 4); COMMIT`);
      subscription = stream
        .subscribe(new ExactPgoutputPlugin('tts_toasted'), 'tts_toasted', lsn)
        .catch((error: unknown) => completion.reject(error));
      const failure = await observed;
      if (failure !== undefined) throw failure;
      let committed;
      for (const frame of frames) {
        const transaction = assembler.push(frame);
        if (transaction) committed = transaction;
      }
      if (!committed) throw new Error('Missing assembled commit');
      expect(committed.events).toHaveLength(4);
      if (!committed.committedAtMicros) throw new Error('Missing commit time');
      const committedTime = BigInt(committed.committedAtMicros);
      expect(committedTime).toBeGreaterThanOrEqual(beforeCommit);
      expect(committedTime).toBeLessThanOrEqual(
        BigInt(Date.now()) * 1000n + 999n,
      );
      expect(assembler.durableState.position).toBe(decodeLsn(lsn));
      const flushPosition = async (): Promise<unknown> =>
        (
          await writer.query(
            'SELECT confirmed_flush_lsn::text AS position FROM pg_replication_slots WHERE slot_name=$1',
            ['tts_toasted'],
          )
        ).rows[0]?.position;
      expect(await flushPosition()).toBe(lsn);
      await store.append('recording', committed);
      await store.close();
      store = await openLocalStore({ path });
      expect(await store.transaction('recording', committed.position)).toEqual(
        committed,
      );
      expect(await store.append('recording', committed)).toBe('duplicate');
      assembler.confirmDurable(committed.position);
      expect(assembler.durableState.position).toBe(committed.position);
      // The pinned library increments its supplied byte position by one.
      expect(
        await stream.acknowledge(
          encodeLsn(
            decodePosition((BigInt(committed.position) - 1n).toString()),
          ),
        ),
      ).toBe(true);
      await expect
        .poll(flushPosition, { timeout: 5000 })
        .toBe(encodeLsn(committed.position));
      const kinds = [];
      for (const frame of frames) {
        if (frame.result.kind !== 'message')
          throw new Error('Unexpected frame failure');
        const message = frame.result.message;
        if (
          message.tag !== 'insert' &&
          message.tag !== 'update' &&
          message.tag !== 'delete'
        )
          continue;
        const event = postgresChange(recording, message, (_table, key) =>
          rows.get(key),
        );
        kinds.push(event.kind);
        const table = recording.schema.tables[0];
        if (!table) throw new Error('Missing table');
        if (event.kind !== 'insert') {
          expect(event.before[1]).toEqual({
            kind: 'scalar',
            type: 'text',
            value: body,
          });
          rows.delete(rowKey(recording, table, event.before));
        }
        if (event.kind !== 'delete')
          rows.set(rowKey(recording, table, event.after), event.after);
      }
      expect(kinds).toEqual(['update', 'update', 'delete', 'insert']);
      expect([...rows.values()]).toEqual([
        [
          { kind: 'scalar', type: 'int8', value: '7' },
          { kind: 'null' },
          { kind: 'scalar', type: 'int4', value: '4' },
        ],
      ]);
    } finally {
      deadline.removeEventListener('abort', abort);
      await stream.stop();
      await subscription;
      await writer.end();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
