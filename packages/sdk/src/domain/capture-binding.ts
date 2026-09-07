import { boundedText, identityText, objectFields } from './validation.js';
import { HistoryError } from './errors.js';

/** Adapter-owned restart metadata. Never include connection credentials.
 * The adapter validates payload semantics before using it to reconnect.
 */
export interface CaptureBinding {
  readonly adapter: string;
  readonly version: number;
  readonly payload: string;
}

export function decodeCaptureBinding(input: unknown): CaptureBinding {
  const data = objectFields(input, ['adapter', 'version', 'payload']);
  if (
    typeof data.version !== 'number' ||
    !Number.isSafeInteger(data.version) ||
    data.version < 1
  )
    throw new HistoryError('INVALID_VALUE', 'Invalid capture binding version.');
  const payload = boundedText(data.payload, 1048576);
  if (!payload.length)
    throw new HistoryError(
      'INVALID_VALUE',
      'Capture binding payload must not be empty.',
    );
  return Object.freeze({
    adapter: identityText(data.adapter),
    version: data.version,
    payload,
  });
}
