import type pg from 'pg';
import type { PostgresConnection } from '@time-travel-sql/source-postgres';
import { applyPostgresSetup } from '@time-travel-sql/source-postgres';

export const setupOptions = {
  publication: 'tts_setup',
  slot: 'tts_setup',
  ownershipToken: '0123456789abcdef0123456789abcdef',
  tables: [{ namespace: 'public', name: 'items' }],
};

export async function setupFixture(
  client: pg.Client,
  connection: PostgresConnection,
) {
  await client.query('CREATE TABLE items(id integer PRIMARY KEY)');
  return applyPostgresSetup(
    connection,
    setupOptions,
    'schema',
    new AbortController().signal,
  );
}
