import { Sql } from '@time-travel-sql/sql-postgres';
import type { ColumnSchema, TableSchema } from '@time-travel-sql/sdk';

export function tableName(table: TableSchema): Sql {
  return Sql.identifier(table.namespace, table.name);
}

function columnType(column: ColumnSchema): Sql {
  const type = Sql.identifier('pg_catalog', column.type);
  const modifier = column.typeModifier;
  if (modifier === -1) return type;
  if (column.type === 'numeric') {
    const encoded = modifier - 4;
    const scale = encoded & 2047;
    return Sql.query`${type}(${Sql.integer(encoded >>> 16)}, ${Sql.integer(scale >= 1024 ? scale - 2048 : scale)})`;
  }
  return Sql.query`${type}(${Sql.integer(column.type === 'varchar' ? modifier - 4 : modifier)})`;
}

/** Metadata is validated before construction. No source DDL is executed.
 * Unavailable non-key cells require private NULL placeholders, so only identity
 * columns carry NOT NULL. Reader grants prevent observing those placeholders.
 */
export function createTable(table: TableSchema): Sql {
  const columns = table.columns.map(
    (column) =>
      Sql.query`${Sql.identifier(column.name)} ${columnType(column)} ${table.primaryKey.includes(column.name) ? Sql.query`NOT NULL` : Sql.query``}`,
  );
  return Sql.query`CREATE TABLE ${tableName(table)} (${Sql.join(columns)}, PRIMARY KEY (${Sql.join(table.primaryKey.map((key) => Sql.identifier(key)))}))`;
}

export function insertRow(table: TableSchema): Sql {
  return Sql.query`INSERT INTO ${tableName(table)} VALUES (${Sql.join(table.columns.map((_, index) => Sql.parameter(index + 1)))})`;
}
