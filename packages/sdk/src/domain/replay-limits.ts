import { HistoryError } from './errors.js';
import { objectFields, utf8Bytes } from './validation.js';
import type { Row } from './schema.js';

export interface ReplayLimits {
  readonly maxRows: number;
  readonly maxBytes: number;
}

export const DEFAULT_REPLAY_LIMITS: ReplayLimits = Object.freeze({
  maxRows: 100000,
  maxBytes: 64 * 1024 * 1024,
});

export function decodeReplayLimits(input: unknown): ReplayLimits {
  const value = objectFields(input, ['maxRows', 'maxBytes']);
  if (
    typeof value.maxRows !== 'number' ||
    !Number.isSafeInteger(value.maxRows) ||
    value.maxRows < 1 ||
    value.maxRows > 1000000 ||
    typeof value.maxBytes !== 'number' ||
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes < 1 ||
    value.maxBytes > 256 * 1024 * 1024
  )
    throw new HistoryError(
      'INVALID_VALUE',
      'Replay limits require 1–1000000 rows and 1–268435456 bytes.',
    );
  return Object.freeze({ maxRows: value.maxRows, maxBytes: value.maxBytes });
}

/** Canonical retained row/key bytes, not an estimate of engine heap overhead. */
export function retainedBytes(key: string, row: Row): number {
  return utf8Bytes(key, 65536) + utf8Bytes(JSON.stringify(row), 1024 * 1024);
}

export function checkReplaySize(
  limits: ReplayLimits,
  rows: number,
  bytes: number,
): void {
  if (rows > limits.maxRows || bytes > limits.maxBytes)
    throw new HistoryError(
      'LIMIT_EXCEEDED',
      'Reconstructed state exceeds its row or byte budget.',
    );
}
