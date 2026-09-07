import pg from 'pg';
import { expect, it } from 'vitest';
import {
  openPostgresBaseline,
  readSnapshot,
  quoteIdentifier,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';
import { postgresRoutingProxy } from '../../test-support/postgres-routing-proxy.js';

it('rejects an independently routed reader before creating any persistent slot', async () => {
  await withPostgres(async (first) => {
    await withPostgres(async (second) => {
      const proxy = await postgresRoutingProxy(first, second);
      try {
        await expect(
          openPostgresBaseline({
            connection: proxy.connection,
            slot: 'tts_routed',
            tables: [{ namespace: 'public', name: 'items' }],
            sourceId: 'source',
            epochId: 'epoch',
            schemaId: 'schema',
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({
          code: 'INVALID_HISTORY',
          message: 'Snapshot reader and exporter differ in source identity.',
        });
        for (const connection of [first, second]) {
          const client = new pg.Client(connection);
          await client.connect();
          try {
            expect(
              (await client.query('SELECT slot_name FROM pg_replication_slots'))
                .rows,
            ).toEqual([]);
          } finally {
            await client.end();
          }
        }
      } finally {
        await proxy.close();
      }
    });
  });
});

it('reads quoted catalog names containing apostrophes, backslashes and SQL punctuation', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    const table = { namespace: "schema'\\é", name: 'table\'\\"; --' };
    const name = `${quoteIdentifier(table.namespace)}.${quoteIdentifier(table.name)}`;
    try {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(table.namespace)};
        CREATE TABLE ${name} (id integer PRIMARY KEY);
        ALTER TABLE ${name} REPLICA IDENTITY FULL;
        INSERT INTO ${name} VALUES (7)`);
      const rows: unknown[] = [];
      for await (const part of readSnapshot({
        connection,
        slot: 'tts_quoted',
        tables: [table],
        signal: new AbortController().signal,
      })) {
        if (part.kind === 'begin') expect(part.tables[0]).toMatchObject(table);
        if (part.kind === 'rows') rows.push(...part.rows);
      }
      expect(rows).toEqual([['7']]);
    } finally {
      await client.end();
    }
  });
});
