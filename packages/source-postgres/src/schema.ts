import { HistoryError, decodeSchema, decodeRow } from '@time-travel-sql/sdk';
import type { Schema, TableSchema, Row } from '@time-travel-sql/sdk';
import type { PostgresTable } from './catalog.js';
import { postgresScalarType } from './scalar-types.js';

export function postgresTableId(oid: string): string {
  if (!/^[1-9][0-9]{0,9}$/.test(oid) || BigInt(oid) > 4294967295n)
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Invalid PostgreSQL relation OID.',
    );
  return 'pg_' + oid;
}

/** Catalog order is row order; primary-key order comes from the primary index. */
export function postgresSchema(
  id: string,
  tables: readonly PostgresTable[],
): Schema {
  return decodeSchema({
    version: 1,
    id,
    tables: tables.map((table) => {
      const keys = table.columns
        .filter((column) => column.keyOrder !== null)
        .sort((left, right) => (left.keyOrder ?? -1) - (right.keyOrder ?? -1));
      if (keys.some((column, index) => column.keyOrder !== index))
        throw new HistoryError(
          'INVALID_SCHEMA',
          'Primary-key ordinals must be contiguous and unique.',
        );
      return {
        id: postgresTableId(table.oid),
        namespace: table.namespace,
        name: table.name,
        columns: table.columns.map((column) => ({
          name: column.name,
          type: postgresScalarType(column.typeOid),
          typeModifier: column.typeModifier,
          nullable: column.nullable,
        })),
        primaryKey: keys.map((column) => column.name),
      };
    }),
  });
}

/** Raw text stays text until canonical SDK validation; missing/TOAST is not NULL. */
export function postgresRow(
  table: TableSchema,
  input: readonly (string | null)[],
): Row {
  if (input.length !== table.columns.length)
    throw new HistoryError(
      'INVALID_VALUE',
      'PostgreSQL row width differs from recorded schema.',
    );
  return decodeRow(
    table,
    table.columns.map((column, index) => {
      const raw = input[index];
      if (raw === null) return { kind: 'null' };
      if (typeof raw !== 'string')
        throw new HistoryError(
          'INVALID_VALUE',
          'Expected an exact PostgreSQL text value.',
        );
      return { kind: 'scalar', type: column.type, value: raw };
    }),
  );
}
