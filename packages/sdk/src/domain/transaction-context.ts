import { HistoryError } from './errors.js';
import { objectFields, boundedText } from './validation.js';

/** Explicit application labels, never database facts or arbitrary request payloads. */
export interface TransactionContext {
  readonly version: 1;
  readonly operation: string;
  readonly requestId?: string;
  readonly traceId?: string;
}

export const TRANSACTION_CONTEXT_MAX_BYTES = 1024;

function label(input: unknown): string {
  const value = boundedText(input, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value))
    throw new HistoryError(
      'INVALID_VALUE',
      'Context labels require 1–128 ASCII identifier characters.',
    );
  return value;
}

export function decodeTransactionContext(input: unknown): TransactionContext {
  const data = objectFields(input, [
    'version',
    'operation',
    'requestId',
    'traceId',
  ]);
  if (data.version !== 1)
    throw new HistoryError(
      'INVALID_VALUE',
      'Unsupported transaction context version.',
    );
  const traceId = data.traceId;
  if (
    'traceId' in data &&
    (typeof traceId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(traceId) ||
      /^0+$/.test(traceId))
  )
    throw new HistoryError(
      'INVALID_VALUE',
      'Context traceId requires 32 nonzero lowercase hexadecimal digits.',
    );
  return Object.freeze({
    version: 1,
    operation: label(data.operation),
    ...('requestId' in data ? { requestId: label(data.requestId) } : {}),
    ...(typeof traceId === 'string' ? { traceId } : {}),
  });
}
