import { HistoryError, decodeRow, findTable } from '@time-travel-sql/sdk';
import type { Schema, QueryLimits } from '@time-travel-sql/sdk';
import { Sql } from '@time-travel-sql/sql-postgres';
import type { PGlite } from '@electric-sql/pglite';
import { createTable, insertRow, tableName } from './schema-sql.js';

/** One instance owns the loading phase of one disposable database. */
export class Materializer {
  readonly #unavailable = new Map<string, Set<string>>();
  readonly #inserts = new Map<string, string>();
  #rows = 0;
  #bytes = 0;
  #finished = false;

  constructor(
    readonly db: PGlite,
    readonly schema: Schema,
    readonly limits: QueryLimits,
  ) {}

  async initialize(): Promise<void> {
    await this.db.exec(`
      SET search_path = pg_catalog, public;
      SET timezone = 'UTC';
      SET datestyle = 'ISO, YMD';
      SET bytea_output = 'hex';
      SET work_mem = '4MB';
      SET temp_file_limit = '64MB';
      CREATE ROLE tts_reader NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      REVOKE ALL ON DATABASE postgres FROM PUBLIC;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
    `);
    for (const namespace of new Set(
      this.schema.tables.map((table) => table.namespace),
    )) {
      if (namespace.startsWith('pg_') || namespace === 'information_schema')
        throw new HistoryError(
          'INVALID_SCHEMA',
          'Recorded schema uses a reserved engine namespace.',
        );
      await this.db.exec(
        Sql.query`CREATE SCHEMA IF NOT EXISTS ${Sql.identifier(namespace)}`
          .text,
      );
      await this.db.exec(
        Sql.query`REVOKE ALL ON SCHEMA ${Sql.identifier(namespace)} FROM PUBLIC`
          .text,
      );
      await this.db.exec(
        Sql.query`GRANT USAGE ON SCHEMA ${Sql.identifier(namespace)} TO tts_reader`
          .text,
      );
    }
    for (const table of this.schema.tables) {
      await this.db.exec(createTable(table).text);
      this.#inserts.set(table.id, insertRow(table).text);
      this.#unavailable.set(table.id, new Set());
    }
  }

  async load(tableId: string, input: unknown): Promise<void> {
    if (this.#finished)
      throw new HistoryError('INVALID_VALUE', 'Query loading is complete.');
    const table = findTable(this.schema, tableId);
    const row = decodeRow(table, input);
    this.#rows++;
    this.#bytes += Buffer.byteLength(JSON.stringify(row));
    if (
      this.#rows > this.limits.maxInputRows ||
      this.#bytes > this.limits.maxInputBytes
    )
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Historical query input exceeds its limit.',
      );
    const unavailable = this.#unavailable.get(tableId);
    const insert = this.#inserts.get(tableId);
    if (!unavailable || !insert)
      throw new HistoryError('INVALID_SCHEMA', 'Unknown query table.');
    const values = row.map((value, index) => {
      const column = table.columns[index];
      if (!column)
        throw new HistoryError('INVALID_SCHEMA', 'Missing query column.');
      if (value.kind === 'scalar') return value.value;
      if (table.primaryKey.includes(column.name))
        throw new HistoryError(
          'INVALID_VALUE',
          'Query identity values must be available.',
        );
      if (value.kind === 'unavailable') unavailable.add(column.name);
      return null;
    });
    // Inferred target OIDs use identity serializers, avoiding coercion through
    // JavaScript numbers, JSON objects, dates or byte arrays.
    await this.db.query(insert, values, { serializers: textSerializers });
  }

  async finish(): Promise<void> {
    if (this.#finished)
      throw new HistoryError('INVALID_VALUE', 'Query loading is complete.');
    this.#finished = true;
    for (const table of this.schema.tables) {
      const missing = this.#unavailable.get(table.id);
      const readable = table.columns.filter(
        (column) => !missing?.has(column.name),
      );
      if (!readable.length)
        throw new HistoryError(
          'INVALID_SCHEMA',
          'No available query identity column.',
        );
      await this.db.exec(
        Sql.query`GRANT SELECT (${Sql.join(readable.map((column) => Sql.identifier(column.name)))}) ON ${tableName(table)} TO tts_reader`
          .text,
      );
    }
  }
}

const textSerializers = Object.fromEntries(
  [16, 21, 23, 20, 1700, 25, 1043, 2950, 1082, 1114, 1184, 114, 3802, 17].map(
    (oid) => [
      oid,
      (value: unknown): string => {
        if (typeof value !== 'string')
          throw new HistoryError(
            'INVALID_VALUE',
            'Expected canonical scalar text.',
          );
        return value;
      },
    ],
  ),
);
