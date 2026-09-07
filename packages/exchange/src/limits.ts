import { HistoryError, decodeDataFields } from '@time-travel-sql/sdk';

export interface ExchangeLimits {
  readonly maxRecordBytes: number;
  readonly maxTotalBytes: number;
  readonly maxRecords: number;
  readonly maxDepth: number;
  readonly maxStructuralTokens: number;
}

export const DEFAULT_EXCHANGE_LIMITS: ExchangeLimits = Object.freeze({
  maxRecordBytes: 18 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxRecords: 1000000,
  maxDepth: 64,
  maxStructuralTokens: 1000000,
});

export function exchangeLimits(input: ExchangeLimits): ExchangeLimits {
  const fields = [
    'maxRecordBytes',
    'maxTotalBytes',
    'maxRecords',
    'maxDepth',
    'maxStructuralTokens',
  ] as const;
  const data = decodeDataFields(input, fields);
  const result = { ...DEFAULT_EXCHANGE_LIMITS };
  for (const key of fields) {
    const value = data[key];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > DEFAULT_EXCHANGE_LIMITS[key]
    )
      throw new HistoryError(
        'INVALID_VALUE',
        `Invalid exchange limit: ${key}.`,
      );
    result[key] = value;
  }
  return Object.freeze(result);
}

export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted)
    throw new HistoryError('CANCELLED', 'Recording exchange cancelled.');
}
