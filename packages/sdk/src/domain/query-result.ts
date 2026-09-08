import { HistoryError } from './errors.js';
import { decodeQueryLimits } from './query.js';
import type { QueryColumn, QueryLimits, QueryResult } from './query.js';
import {
  boundedArray,
  boundedText,
  objectFields,
  utf8Bytes,
} from './validation.js';

/** Incremental, fail-closed result accounting. The byte limit covers the entire
 * compact JSON QueryResult, including column metadata and JSON string escaping.
 * This limits retained output, not allocation or execution inside an SQL engine.
 */
export class QueryResultBuffer {
  readonly #limits: QueryLimits;
  readonly #columns: readonly QueryColumn[];
  readonly #rows: (readonly (string | null)[])[] = [];
  #bytes: number;
  #state: 'open' | 'failed' | 'finished' = 'open';

  constructor(columns: unknown, limits: unknown = {}) {
    this.#limits = decodeQueryLimits(limits);
    if (Array.isArray(columns) && columns.length > this.#limits.maxColumns)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Query exceeds its column limit.',
      );
    this.#columns = Object.freeze(
      boundedArray(columns, this.#limits.maxColumns).map((input) => {
        const data = objectFields(input, ['name', 'typeOid']);
        const name = boundedText(data.name, 1024);
        const typeOid = data.typeOid;
        if (
          typeof typeOid !== 'number' ||
          !Number.isInteger(typeOid) ||
          typeOid < 1 ||
          typeOid > 4294967295
        )
          throw new HistoryError('INVALID_VALUE', 'Invalid query result type.');
        return Object.freeze({ name, typeOid });
      }),
    );
    this.#bytes = utf8Bytes(
      JSON.stringify({ columns: this.#columns, rows: [] }),
      this.#limits.maxResultBytes,
    );
  }

  append(input: unknown): void {
    this.#assertOpen();
    try {
      if (this.#rows.length === this.#limits.maxRows)
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'Query exceeds its row limit.',
        );
      const cells = boundedArray(input, this.#columns.length);
      if (cells.length !== this.#columns.length)
        throw new HistoryError(
          'INVALID_VALUE',
          'Query row width does not match its columns.',
        );
      const remaining = this.#limits.maxResultBytes - this.#bytes;
      let bytes = utf8Bytes(this.#rows.length ? ',[]' : '[]', remaining);
      const row: (string | null)[] = [];
      for (const cell of cells) {
        const value =
          cell === null ? null : boundedText(cell, this.#limits.maxCellBytes);
        if (row.length) bytes++;
        bytes += utf8Bytes(JSON.stringify(value), remaining - bytes);
        row.push(value);
      }
      this.#rows.push(Object.freeze(row));
      this.#bytes += bytes;
    } catch (error) {
      this.#state = 'failed';
      this.#rows.length = 0;
      throw error;
    }
  }

  finish(): QueryResult {
    this.#assertOpen();
    this.#state = 'finished';
    return Object.freeze({
      columns: this.#columns,
      rows: Object.freeze(this.#rows),
    });
  }

  #assertOpen(): void {
    if (this.#state !== 'open')
      throw new HistoryError(
        'INVALID_VALUE',
        'Query result buffer is no longer open.',
      );
  }
}
