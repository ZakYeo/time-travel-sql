import pg from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Position } from '@time-travel-sql/sdk';
import {
  decodeRecordingMetadata,
  reconstructionRows,
} from '@time-travel-sql/sdk';
import {
  readSnapshot,
  postgresSchema,
  postgresRow,
  postgresTableId,
} from '@time-travel-sql/source-postgres';
import {
  openLocalStore,
  createLocalReconstructor,
} from '@time-travel-sql/storage-local';
import { withPostgres } from '../../test-support/postgres.js';

it('persists and reconstructs a real exact snapshot through public package boundaries', async () => {
  await withPostgres(async (connection) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-canonical-snapshot-'));
    const path = join(root, 'history.sqlite');
    const store = await openLocalStore({ path });
    const reader = createLocalReconstructor({ path });
    const client = new pg.Client(connection);
    await client.connect();
    try {
      await client.query(`CREATE TABLE exact_rows (
        id bigint NOT NULL, tenant text NOT NULL,
        amount numeric, enabled boolean, small smallint, regular integer,
        label varchar(8), token uuid, day date, local_time timestamp,
        instant timestamptz, document json, indexed_document jsonb, bytes bytea,
        PRIMARY KEY (tenant, id));
        ALTER TABLE exact_rows REPLICA IDENTITY FULL`);
      await client.query(`INSERT INTO exact_rows VALUES (
        9223372036854775807, '', 12345678901234567890.123456, true, -32768, 2147483647,
        '😀界', 'aabbccdd-0011-2233-4455-66778899aabb', '2024-02-29',
        '2026-01-02 03:04:05.123456', '2026-01-02 03:04:05.123456+00',
        '{"n":9007199254740993}', '{"n":9007199254740993}', '\\x00ff')`);
      let metadata: ReturnType<typeof decodeRecordingMetadata> | undefined;
      let position: Position | undefined;
      for await (const part of readSnapshot({
        connection,
        slot: 'tts_canonical_snapshot',
        tables: [{ namespace: 'public', name: 'exact_rows' }],
        signal: new AbortController().signal,
      })) {
        if (part.kind === 'begin') {
          position = part.position;
          metadata = decodeRecordingMetadata({
            id: 'recording',
            name: 'Exact snapshot',
            createdAt: '2026-01-01 00:00:00Z',
            recording: {
              sourceId: 'pg_' + part.systemId + '_' + part.databaseOid,
              epochId: 'epoch',
              schema: postgresSchema('schema', part.tables),
            },
          });
          await store.create(metadata);
        } else if (part.kind === 'rows') {
          const table = metadata?.recording.schema.tables.find(
            (table) => table.id === postgresTableId(part.tableOid),
          );
          if (!table) throw new Error('Rows before schema');
          await store.stageBaseline(
            'recording',
            part.rows.map((input) => ({
              tableId: table.id,
              row: postgresRow(table, input),
            })),
          );
        } else {
          if (!position) throw new Error('Completion before position');
          await store.publishBaseline('recording', position);
        }
      }
      const session = await reader.open({
        recordingId: 'recording',
        selection: { kind: 'baseline' },
      });
      const values = [];
      for await (const row of reconstructionRows(session)) values.push(row.row);
      expect(values).toEqual([
        [
          { kind: 'scalar', type: 'int8', value: '9223372036854775807' },
          { kind: 'scalar', type: 'text', value: '' },
          {
            kind: 'scalar',
            type: 'numeric',
            value: '12345678901234567890.123456',
          },
          { kind: 'scalar', type: 'bool', value: 'true' },
          { kind: 'scalar', type: 'int2', value: '-32768' },
          { kind: 'scalar', type: 'int4', value: '2147483647' },
          { kind: 'scalar', type: 'varchar', value: '😀界' },
          {
            kind: 'scalar',
            type: 'uuid',
            value: 'aabbccdd-0011-2233-4455-66778899aabb',
          },
          { kind: 'scalar', type: 'date', value: '2024-02-29' },
          {
            kind: 'scalar',
            type: 'timestamp',
            value: '2026-01-02 03:04:05.123456',
          },
          {
            kind: 'scalar',
            type: 'timestamptz',
            value: '2026-01-02 03:04:05.123456Z',
          },
          { kind: 'scalar', type: 'json', value: '{"n":9007199254740993}' },
          { kind: 'scalar', type: 'jsonb', value: '{"n": 9007199254740993}' },
          { kind: 'scalar', type: 'bytea', value: '\\x00ff' },
        ],
      ]);
      expect(
        session.info.recording.recording.schema.tables[0]?.primaryKey,
      ).toEqual(['tenant', 'id']);
      await session.close();
    } finally {
      await reader.close();
      await store.close();
      await client.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
