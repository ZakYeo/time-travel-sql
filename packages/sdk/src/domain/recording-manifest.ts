import { HistoryError } from './errors.js';
import { decodeRecordingInfo } from './recordings.js';
import type { RecordingInfo } from './recordings.js';
import type { Position } from './position.js';
import { objectFields } from './validation.js';

export const HISTORY_WORK_LIMITS = Object.freeze({
  maxBytes: 512 * 1024 * 1024,
  maxRows: 1000000,
  maxTransactions: 100000,
  maxEvents: 1000000,
});

export interface RecordingManifest {
  readonly kind: 'manifest';
  readonly version: 1;
  readonly info: RecordingInfo & {
    readonly baselinePosition: Position;
    readonly headPosition: Position;
    readonly baselineRowCount: number;
    readonly baselineChecksum: string;
  };
  /** SHA-256 of the canonical RecordingSchema JSON: captured projection and identity.
   * No credentials, local lifecycle, driver settings or source ownership receipts.
   */
  readonly captureConfigurationFingerprint: string;
}

export function decodeRecordingManifest(input: unknown): RecordingManifest {
  const data = objectFields(input, [
    'kind',
    'version',
    'info',
    'captureConfigurationFingerprint',
  ]);
  if (data.kind !== 'manifest' || data.version !== 1)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Unsupported recording manifest version.',
    );
  const info = decodeRecordingInfo(data.info);
  const { baselinePosition, headPosition, baselineRowCount, baselineChecksum } =
    info;
  if (
    baselinePosition === null ||
    headPosition === null ||
    baselineRowCount === null ||
    baselineChecksum === null
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Portable recordings require published coverage.',
    );
  if (
    baselineRowCount > HISTORY_WORK_LIMITS.maxRows ||
    info.transactionCount > HISTORY_WORK_LIMITS.maxTransactions
  )
    throw new HistoryError(
      'LIMIT_EXCEEDED',
      'Declared recording counts exceed import limits.',
    );
  const fingerprint = data.captureConfigurationFingerprint;
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint))
    throw new HistoryError(
      'INVALID_HISTORY',
      'Invalid capture configuration fingerprint.',
    );
  return Object.freeze({
    kind: 'manifest',
    version: 1,
    info: Object.freeze({
      ...info,
      baselinePosition,
      headPosition,
      baselineRowCount,
      baselineChecksum,
    }),
    captureConfigurationFingerprint: fingerprint,
  });
}
