import pg from 'pg';
import { expect, it } from 'vitest';
import {
  inspectPostgresCapture,
  inspectPostgresIdentity,
} from '@time-travel-sql/source-postgres';
import type { PostgresConnection } from '@time-travel-sql/source-postgres';
import { decodePosition } from '@time-travel-sql/sdk';
import { withPostgres } from '../../test-support/postgres.js';

async function prepare(connection: PostgresConnection): Promise<void> {
  const client = new pg.Client(connection);
  await client.connect();
  try {
    await client.query(`CREATE TABLE items (id integer PRIMARY KEY); ALTER TABLE items REPLICA IDENTITY FULL;
      CREATE PUBLICATION tts_identity FOR TABLE items`);
  } finally {
    await client.end();
  }
}

it('rejects a different cluster even when database and table OIDs match', async () => {
  await withPostgres(async (first) => {
    await prepare(first);
    const options = {
      publication: 'tts_identity',
      schemaId: 'schema',
      tables: [{ namespace: 'public', name: 'items' }],
      signal: new AbortController().signal,
    };
    const original = await inspectPostgresCapture({
      ...options,
      connection: first,
    });
    const identity = await inspectPostgresIdentity(first, options.signal);
    expect(identity.systemId).toBe(original.systemId);
    expect(identity.timeline).toBe(original.timeline);
    expect(identity.database).toBe(first.database);
    await withPostgres(async (second) => {
      await prepare(second);
      const other = await inspectPostgresCapture({
        ...options,
        connection: second,
      });
      expect(other.databaseOid).toBe(original.databaseOid);
      expect(other.schema).toEqual(original.schema);
      expect(other.systemId).not.toBe(original.systemId);
      await expect(
        inspectPostgresCapture({
          ...options,
          connection: second,
          resume: {
            systemId: original.systemId,
            timeline: original.timeline,
            databaseOid: original.databaseOid,
            schema: original.schema,
            slot: 'tts_identity',
            durablePosition: decodePosition('0'),
          },
        }),
      ).rejects.toThrow('Cluster identity');
    });
  });
});
