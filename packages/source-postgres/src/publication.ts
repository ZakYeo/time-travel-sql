import type pg from 'pg';
import { HistoryError } from '@time-travel-sql/sdk';
import { textRows } from './connection.js';
import { validateSlotName } from './identifiers.js';
import type { PostgresTable } from './catalog.js';

export async function inspectPublication(
  client: pg.Client,
  name: string,
  tables: readonly PostgresTable[],
): Promise<void> {
  validateSlotName(name);
  const config = textRows(
    (
      await client.query({
        text: `SELECT p.puballtables::text, p.pubinsert::text,
    p.pubupdate::text, p.pubdelete::text, p.pubtruncate::text, p.pubviaroot::text,
    EXISTS(SELECT 1 FROM pg_catalog.pg_publication_namespace n WHERE n.pnpubid=p.oid)::text
    FROM pg_catalog.pg_publication p WHERE p.pubname=$1`,
        values: [name],
        rowMode: 'array',
      })
    ).rows,
  )[0];
  if (
    !config ||
    JSON.stringify(config) !==
      JSON.stringify([
        'false',
        'true',
        'true',
        'true',
        'true',
        'false',
        'false',
      ])
  )
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Publication must explicitly include selected tables and all change kinds without schema-wide or partition-root expansion.',
    );
  const rows = textRows(
    (
      await client.query({
        text: `SELECT r.prrelid::text, (r.prattrs IS NULL)::text, (r.prqual IS NULL)::text
    FROM pg_catalog.pg_publication_rel r JOIN pg_catalog.pg_publication p ON p.oid=r.prpubid
    WHERE p.pubname=$1 LIMIT 65`,
        values: [name],
        rowMode: 'array',
      })
    ).rows,
  );
  const selected = new Set(tables.map((table) => table.oid));
  if (
    rows.length !== selected.size ||
    rows.some(
      ([oid, allColumns, noFilter]) =>
        !oid ||
        !selected.has(oid) ||
        allColumns !== 'true' ||
        noFilter !== 'true',
    )
  )
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Publication must match the exact selected tables with every column and no row filters.',
    );
}
