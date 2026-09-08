import { HistoryError } from './errors.js';
import { objectFields } from './validation.js';
import type { Position } from './position.js';
import type { Row } from './schema.js';

export interface RowHistoryOptions {
  readonly offset: number;
  readonly limit: number;
  readonly maxResultBytes: number;
  readonly maxInputBytes: number;
  readonly maxTransactions: number;
  readonly maxEvents: number;
}
export const DEFAULT_ROW_HISTORY_OPTIONS: RowHistoryOptions = Object.freeze({
  offset: 0,
  limit: 100,
  maxResultBytes: 8 * 1048576,
  maxInputBytes: 256 * 1048576,
  maxTransactions: 10000,
  maxEvents: 100000,
});
export const MAX_ROW_HISTORY_OPTIONS: RowHistoryOptions = Object.freeze({
  offset: 2000000,
  limit: 1000,
  maxResultBytes: 16 * 1048576,
  maxInputBytes: 1024 * 1048576,
  maxTransactions: 100000,
  maxEvents: 1000000,
});

export function decodeRowHistoryOptions(
  input: unknown = {},
): RowHistoryOptions {
  const keys = [
    'offset',
    'limit',
    'maxResultBytes',
    'maxInputBytes',
    'maxTransactions',
    'maxEvents',
  ] as const;
  const data = objectFields(input, keys);
  const result = { ...DEFAULT_ROW_HISTORY_OPTIONS };
  for (const key of keys) {
    const value = data[key] === undefined ? result[key] : data[key];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < (key === 'offset' ? 0 : 1) ||
      value > MAX_ROW_HISTORY_OPTIONS[key]
    )
      throw new HistoryError('INVALID_VALUE', 'Invalid row history limit.');
    result[key] = value;
  }
  return Object.freeze(result);
}
export type RowOrigin =
  | { readonly kind: 'baseline'; readonly key: string }
  | {
      readonly kind: 'insert';
      readonly position: Position;
      readonly eventIndex: number;
    };
export interface RowHistoryEntry {
  readonly kind: 'baseline' | 'insert' | 'update' | 'delete';
  readonly position: Position;
  readonly transactionId: string | null;
  readonly eventIndex: number | null;
  readonly committedAtMicros: string | null;
  readonly beforeKey: string | null;
  readonly afterKey: string | null;
  readonly before: Row | null;
  readonly after: Row | null;
}
