import { HistoryError } from './errors.js';
import { objectFields, identityText } from './validation.js';
import type { Row } from './schema.js';
import type { Value } from './values.js';

export interface InvestigationOptions {
  readonly tableId?: string;
  readonly offset: number;
  readonly limit: number;
  readonly maxResultBytes: number;
  readonly maxInputRows: number;
  readonly maxInputBytes: number;
}
export const DEFAULT_INVESTIGATION_OPTIONS: InvestigationOptions =
  Object.freeze({
    offset: 0,
    limit: 100,
    maxResultBytes: 8 * 1024 * 1024,
    maxInputRows: 200000,
    maxInputBytes: 128 * 1024 * 1024,
  });
export function decodeInvestigationOptions(
  input: unknown = {},
): InvestigationOptions {
  const data = objectFields(input, [
    'tableId',
    'offset',
    'limit',
    'maxResultBytes',
    'maxInputRows',
    'maxInputBytes',
  ]);
  const result = { ...DEFAULT_INVESTIGATION_OPTIONS };
  const maxima = {
    offset: 2000000,
    limit: 1000,
    maxResultBytes: 16 * 1024 * 1024,
    maxInputRows: 2000000,
    maxInputBytes: 512 * 1024 * 1024,
  };
  for (const key of [
    'offset',
    'limit',
    'maxResultBytes',
    'maxInputRows',
    'maxInputBytes',
  ] as const) {
    const value = data[key] === undefined ? result[key] : data[key];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < (key === 'offset' ? 0 : 1) ||
      value > maxima[key]
    )
      throw new HistoryError('INVALID_VALUE', 'Invalid investigation limit.');
    result[key] = value;
  }
  return Object.freeze(
    data.tableId === undefined
      ? result
      : { ...result, tableId: identityText(data.tableId) },
  );
}

export interface KeyedRow {
  readonly tableId: string;
  readonly key: string;
  readonly row: Row;
}
export interface FieldDifference {
  readonly column: string;
  readonly before: Value;
  readonly after: Value;
}
export interface RowDifference {
  readonly tableId: string;
  readonly key: string;
  readonly kind: 'insert' | 'delete' | 'update';
  readonly before: Row | null;
  readonly after: Row | null;
  readonly fields: readonly FieldDifference[];
}
