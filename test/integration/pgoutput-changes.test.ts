import pg from 'pg';
import { LogicalReplicationService } from 'pg-logical-replication';
import { expect, it } from 'vitest';
import { decodeRecordingSchema, rowKey } from '@time-travel-sql/sdk';
import type { RecordingSchema, Row } from '@time-travel-sql/sdk';
import {
  readSnapshot,
  postgresSchema,
  postgresRow,
  postgresChange,
  PgoutputFrame,
  ExactPgoutputPlugin,
  encodeLsn,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';

it('normalizes real TOAST updates, repeated changes and key changes from recorded state', async () => {
  await withPostgres(async (connection) => {
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
      await writer.query(`BEGIN; UPDATE toasted SET count=2;
        UPDATE toasted SET id=9007199254740994, count=3;
        DELETE FROM toasted; INSERT INTO toasted VALUES (7, NULL, 4); COMMIT`);
      subscription = stream
        .subscribe(new ExactPgoutputPlugin('tts_toasted'), 'tts_toasted', lsn)
        .catch((error: unknown) => completion.reject(error));
      const failure = await observed;
      if (failure !== undefined) throw failure;
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
    }
  });
});
