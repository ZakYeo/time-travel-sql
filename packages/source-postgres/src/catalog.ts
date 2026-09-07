import type pg from 'pg';
import { HistoryError } from '@time-travel-sql/sdk';
import { quoteIdentifier } from './identifiers.js';
import { textRows } from './connection.js';

export interface TableSelection {
  readonly namespace: string;
  readonly name: string;
}

export interface PostgresColumn {
  readonly name: string;
  readonly typeOid: number;
  readonly typeModifier: number;
  readonly nullable: boolean;
  readonly keyOrder: number | null;
}

export interface PostgresTable extends TableSelection {
  readonly oid: string;
  readonly columns: readonly PostgresColumn[];
}

const supportedOids = new Set([
  16, 20, 21, 23, 25, 1043, 1700, 2950, 1082, 1114, 1184, 114, 3802, 17,
]);

export function qualifiedName(table: TableSelection): string {
  return `${quoteIdentifier(table.namespace)}.${quoteIdentifier(table.name)}`;
}

export async function inspectTable(
  client: pg.Client,
  table: TableSelection,
): Promise<PostgresTable> {
  const result = await client.query({
    text: `SELECT c.oid::text, c.relkind, c.relpersistence, c.relispartition::text,
      c.relrowsecurity::text, c.relreplident, a.attname, a.atttypid::text,
      a.atttypmod::text, a.attnotnull::text, a.attgenerated,
      CASE WHEN array_position(i.indkey, a.attnum) < i.indnkeyatts
        THEN array_position(i.indkey, a.attnum)::text END
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_catalog.pg_index i ON i.indrelid=c.oid AND i.indisprimary AND i.indisvalid
      WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    values: [table.namespace, table.name],
    rowMode: 'array',
  });
  const rows = textRows(result.rows);
  if (!rows.length || rows.length > 128)
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Selected table must exist and have 1–128 columns.',
    );
  const columns = rows.map((row): PostgresColumn => {
    const [
      oid,
      kind,
      persistence,
      partition,
      rls,
      identity,
      name,
      type,
      modifier,
      notNull,
      generated,
      keyOrder,
    ] = row;
    if (
      !oid ||
      kind !== 'r' ||
      persistence !== 'p' ||
      partition !== 'false' ||
      rls !== 'false' ||
      identity !== 'f' ||
      generated !== '' ||
      !name ||
      !type ||
      !modifier ||
      keyOrder === undefined
    ) {
      throw new HistoryError(
        'INVALID_SCHEMA',
        'Capture requires permanent, nonpartitioned tables without RLS/generated columns, and REPLICA IDENTITY FULL.',
      );
    }
    if (!supportedOids.has(Number(type)))
      throw new HistoryError(
        'INVALID_SCHEMA',
        'Selected table contains an unsupported PostgreSQL type.',
      );
    return {
      name,
      typeOid: Number(type),
      typeModifier: Number(modifier),
      nullable: notNull !== 'true',
      keyOrder: keyOrder === null ? null : Number(keyOrder),
    };
  });
  const oid = rows[0]?.[0];
  if (!oid || !columns.some((column) => column.keyOrder !== null))
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Selected tables require a valid primary key.',
    );
  return { ...table, oid, columns };
}
