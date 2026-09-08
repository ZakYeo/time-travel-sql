import { HistoryError } from './errors.js';
import { objectFields } from './validation.js';

export interface ScanLimits {
  readonly timeoutMs: number;
  readonly maxStates: number;
  readonly maxTransactions: number;
  readonly maxEvents: number;
  /** Aggregate baseline, transaction and evaluated-state input bytes. */
  readonly maxBytes: number;
}
export const DEFAULT_SCAN_LIMITS: ScanLimits = Object.freeze({
  timeoutMs: 300000,
  maxStates: 1000,
  maxTransactions: 10000,
  maxEvents: 100000,
  maxBytes: 256 * 1048576,
});
const maximum: ScanLimits = {
  timeoutMs: 3600000,
  maxStates: 10000,
  maxTransactions: 100000,
  maxEvents: 1000000,
  maxBytes: 1024 * 1048576,
};
export function decodeScanLimits(input: unknown = {}): ScanLimits {
  const keys = [
    'timeoutMs',
    'maxStates',
    'maxTransactions',
    'maxEvents',
    'maxBytes',
  ] as const;
  const data = objectFields(input, keys);
  const result = { ...DEFAULT_SCAN_LIMITS };
  for (const key of keys) {
    const value = data[key] === undefined ? result[key] : data[key];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > maximum[key]
    )
      throw new HistoryError('INVALID_VALUE', 'Invalid invariant scan limit.');
    result[key] = value;
  }
  return Object.freeze(result);
}
