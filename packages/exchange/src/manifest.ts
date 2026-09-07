import { createHash } from 'node:crypto';
import {
  decodeRecordingManifest,
  decodeRecordingInfo,
  HistoryError,
} from '@time-travel-sql/sdk';
import type { RecordingManifest, RecordingInfo } from '@time-travel-sql/sdk';

export function manifestFor(
  input: RecordingInfo,
  maxRecords: number,
): RecordingManifest {
  const info = decodeRecordingInfo(input);
  const manifest = decodeRecordingManifest({
    kind: 'manifest',
    version: 1,
    info,
    captureConfigurationFingerprint: createHash('sha256')
      .update(JSON.stringify(info.recording))
      .digest('hex'),
  });
  if (
    1 + manifest.info.baselineRowCount + manifest.info.transactionCount >
    maxRecords
  )
    throw new HistoryError(
      'LIMIT_EXCEEDED',
      'Declared recording exceeds the frame count budget.',
    );
  return manifest;
}

export function verifiedManifest(
  input: unknown,
  maxRecords: number,
): RecordingManifest {
  const manifest = decodeRecordingManifest(input);
  if (
    manifest.captureConfigurationFingerprint !==
    manifestFor(manifest.info, maxRecords).captureConfigurationFingerprint
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Capture configuration fingerprint mismatch.',
    );
  return manifest;
}
