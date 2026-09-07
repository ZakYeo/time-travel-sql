import type { PostgresTable } from './catalog.js';
import { qualifiedName } from './catalog.js';
import { quoteIdentifier } from './identifiers.js';

export const snapshotRowByteLimit = 1024 * 1024;

/** Oversized rows return only a rejection marker, bounding data sent to the recorder. */
export function snapshotQuery(table: PostgresTable): string {
  const columns = table.columns.map(
    (column) => `${quoteIdentifier(column.name)}::text`,
  );
  const size = columns
    .map((column) => `COALESCE(octet_length(${column}), 0)::bigint`)
    .join(' + ');
  const permitted = `(${size}) <= ${snapshotRowByteLimit}`;
  const values = columns.map(
    (column) => `CASE WHEN ${permitted} THEN ${column} END`,
  );
  return `SELECT (${permitted})::text, ${values.join(', ')} FROM ONLY ${qualifiedName(table)}`;
}
