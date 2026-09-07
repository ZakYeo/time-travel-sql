import type { PostgresTable } from './catalog.js';
import { Sql } from './sql.js';

export const snapshotRowByteLimit = 1024 * 1024;

/** Oversized rows return only a rejection marker, bounding data sent to the recorder. */
export function snapshotQuery(table: PostgresTable): string {
  const columns = table.columns.map(
    (column) => Sql.query`${Sql.identifier(column.name)}::text`,
  );
  const size = Sql.join(
    columns.map(
      (column) => Sql.query`COALESCE(octet_length(${column}), 0)::bigint`,
    ),
    Sql.query` + `,
  );
  const permitted = Sql.query`(${size}) <= ${Sql.integer(snapshotRowByteLimit)}`;
  const values = columns.map(
    (column) => Sql.query`CASE WHEN ${permitted} THEN ${column} END`,
  );
  return Sql.query`SELECT (${permitted})::text, ${Sql.join(values)} FROM ONLY ${Sql.identifier(table.namespace, table.name)}`
    .text;
}
