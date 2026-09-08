import { HistoryError } from './errors.js';
import { boundedText, objectFields } from './validation.js';

export interface QueryLimits {
  readonly timeoutMs: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCellBytes: number;
  readonly maxResultBytes: number;
  readonly maxInputRows: number;
  readonly maxInputBytes: number;
}

export const DEFAULT_QUERY_LIMITS: QueryLimits = Object.freeze({
  timeoutMs: 30000,
  maxRows: 1000,
  maxColumns: 128,
  maxCellBytes: 1048576,
  maxResultBytes: 8 * 1048576,
  maxInputRows: 200000,
  maxInputBytes: 128 * 1048576,
});
export const MAX_QUERY_LIMITS: QueryLimits = Object.freeze({
  timeoutMs: 300000,
  maxRows: 10000,
  maxColumns: 1024,
  maxCellBytes: 1048576,
  maxResultBytes: 16 * 1048576,
  maxInputRows: 2000000,
  maxInputBytes: 512 * 1048576,
});
const keys = [
  'timeoutMs',
  'maxRows',
  'maxColumns',
  'maxCellBytes',
  'maxResultBytes',
  'maxInputRows',
  'maxInputBytes',
] as const;

export function decodeQueryLimits(input: unknown = {}): QueryLimits {
  const data = objectFields(input, keys);
  const result = { ...DEFAULT_QUERY_LIMITS };
  for (const key of keys) {
    const value = data[key] === undefined ? result[key] : data[key];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > MAX_QUERY_LIMITS[key]
    )
      throw new HistoryError(
        'INVALID_VALUE',
        'Invalid historical query limit.',
      );
    result[key] = value;
  }
  return Object.freeze(result);
}

export interface QueryRequest {
  readonly sql: string;
  readonly limits: QueryLimits;
}

export function decodeQueryRequest(input: unknown): QueryRequest {
  const data = objectFields(input, ['sql', 'limits']);
  const sql = boundedText(data.sql, 65536);
  if (!sql.trim())
    throw new HistoryError(
      'INVALID_VALUE',
      'Historical SQL must not be empty.',
    );
  return Object.freeze({ sql, limits: decodeQueryLimits(data.limits) });
}

export interface QueryColumn {
  readonly name: string;
  /** PostgreSQL result type OID, including expression types outside capture types. */
  readonly typeOid: number;
}

/** Text protocol values preserve exact numbers, JSON and temporal precision.
 * SQL NULL is null; duplicate column names retain their ordinal positions.
 */
export interface QueryResult {
  readonly columns: readonly QueryColumn[];
  readonly rows: readonly (readonly (string | null)[])[];
}
