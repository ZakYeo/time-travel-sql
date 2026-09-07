import { createHash } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import { HistoryError } from '@time-travel-sql/sdk';

export const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;

export function encode(input: unknown): { data: string; digest: string } {
  const data = JSON.stringify(input);
  if (data === undefined || Buffer.byteLength(data) > MAX_MESSAGE_BYTES)
    throw new HistoryError(
      'LIMIT_EXCEEDED',
      'Storage message exceeds its byte limit.',
    );
  return { data, digest: createHash('sha256').update(data).digest('hex') };
}

export function readRecord(
  row: Record<string, SQLOutputValue> | undefined,
): unknown {
  if (!row)
    throw new HistoryError('INVALID_HISTORY', 'Recorded item does not exist.');
  const { data, digest } = row;
  if (
    typeof data !== 'string' ||
    typeof digest !== 'string' ||
    Buffer.byteLength(data) > MAX_MESSAGE_BYTES ||
    createHash('sha256').update(data).digest('hex') !== digest
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recorded item failed its integrity check.',
    );
  try {
    const value: unknown = JSON.parse(data);
    return value;
  } catch (cause) {
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recorded item is not valid JSON.',
      { cause },
    );
  }
}
