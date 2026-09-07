import {
  decodeCaptureBinding,
  decodeDataFields,
  decodeRecordingSchema,
  HistoryError,
} from '@time-travel-sql/sdk';
import type { CaptureBinding } from '@time-travel-sql/sdk';
import { decodePostgresSetupReceipt } from './setup-receipt.js';
import type { PostgresSetupReceipt } from './setup-receipt.js';

/** Only canonical setup observations are persisted; connection options are excluded. */
export function createPostgresCaptureBinding(
  recordingInput: unknown,
  receiptInput: unknown,
): CaptureBinding {
  const recording = decodeRecordingSchema(recordingInput);
  const receipt = decodePostgresSetupReceipt(receiptInput);
  if (JSON.stringify(recording.schema) !== JSON.stringify(receipt.schema))
    throw new HistoryError(
      'INVALID_HISTORY',
      'Capture receipt differs from the recording schema.',
    );
  return decodeCaptureBinding({
    adapter: 'postgres',
    version: 1,
    payload: JSON.stringify({
      sourceId: recording.sourceId,
      epochId: recording.epochId,
      receipt,
    }),
  });
}

/** Revalidate after storage/import; a receipt alone never authorizes slot deletion. */
export function readPostgresCaptureBinding(
  recordingInput: unknown,
  bindingInput: unknown,
): PostgresSetupReceipt {
  const recording = decodeRecordingSchema(recordingInput);
  const binding = decodeCaptureBinding(bindingInput);
  if (binding.adapter !== 'postgres' || binding.version !== 1)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Unsupported PostgreSQL capture binding.',
    );
  let payload: unknown;
  try {
    payload = JSON.parse(binding.payload);
  } catch (cause) {
    throw new HistoryError(
      'INVALID_HISTORY',
      'Invalid PostgreSQL capture binding payload.',
      { cause },
    );
  }
  const data = decodeDataFields(payload, ['sourceId', 'epochId', 'receipt']);
  if (
    data.sourceId !== recording.sourceId ||
    data.epochId !== recording.epochId
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Capture binding belongs to another source or epoch.',
    );
  const receipt = decodePostgresSetupReceipt(data.receipt);
  // Share the schema compatibility policy and canonical payload construction.
  createPostgresCaptureBinding(recording, receipt);
  return receipt;
}
