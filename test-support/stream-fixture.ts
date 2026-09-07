import pg from 'pg';
import { HistoryState, decodeRecordingSchema } from '@time-travel-sql/sdk';
import type { RecordingSchema, SnapshotRow } from '@time-travel-sql/sdk';
import {
  readSnapshot,
  postgresSchema,
  postgresRow,
} from '@time-travel-sql/source-postgres';
import type {
  PostgresConnection,
  PostgresStreamOptions,
} from '@time-travel-sql/source-postgres';

export async function streamFixture(
  connection: PostgresConnection,
  signal: AbortSignal,
): Promise<PostgresStreamOptions> {
  const client = new pg.Client(connection);
  await client.connect();
  try {
    await client.query(`CREATE TABLE items (id integer PRIMARY KEY, value integer);
      ALTER TABLE items REPLICA IDENTITY FULL; INSERT INTO items VALUES (1, 0);
      CREATE PUBLICATION tts_stream FOR TABLE items`);
  } finally {
    await client.end();
  }
  let recording: RecordingSchema | undefined;
  let start:
    | {
        position: string;
        systemId: string;
        timeline: string;
        databaseOid: string;
      }
    | undefined;
  const rows: SnapshotRow[] = [];
  for await (const part of readSnapshot({
    connection,
    slot: 'tts_stream',
    tables: [{ namespace: 'public', name: 'items' }],
    signal,
  })) {
    if (part.kind === 'begin') {
      start = part;
      recording = decodeRecordingSchema({
        sourceId: 'source',
        epochId: 'epoch',
        schema: postgresSchema('schema', part.tables),
      });
    } else if (part.kind === 'rows') {
      const table = recording?.schema.tables[0];
      if (!table) throw new Error('Missing schema');
      rows.push(
        ...part.rows.map((raw) => ({
          tableId: table.id,
          row: postgresRow(table, raw),
        })),
      );
    }
  }
  if (!recording || !start) throw new Error('Missing baseline');
  return {
    connection,
    slot: 'tts_stream',
    publication: 'tts_stream',
    systemId: start.systemId,
    timeline: start.timeline,
    databaseOid: start.databaseOid,
    state: HistoryState.fromSnapshot(recording, start.position, rows),
    signal,
  };
}
