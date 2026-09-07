import { isAbsolute } from 'node:path';
import { HistoryError } from '@time-travel-sql/sdk';

export function recordingFilePath(input: string): string {
  if (
    typeof input !== 'string' ||
    !isAbsolute(input) ||
    input.includes('\0') ||
    !input.isWellFormed() ||
    Buffer.byteLength(input) > 65536
  )
    throw new HistoryError(
      'INVALID_VALUE',
      'Recording files require a bounded absolute path.',
    );
  return input;
}

/** Preserve domain/cleanup errors and normalize only actual I/O cancellation. */
export function fileFailure(error: unknown): Error {
  if (error instanceof HistoryError || error instanceof AggregateError)
    return error;
  if (error instanceof Error && 'code' in error && error.code === 'ABORT_ERR')
    return new HistoryError(
      'CANCELLED',
      'Recording file operation cancelled.',
      { cause: error },
    );
  return new HistoryError(
    'STORAGE_FAILURE',
    'Recording file operation failed.',
    { cause: error },
  );
}

export function fileFailures(errors: readonly unknown[]): Error {
  if (errors.length === 1) return fileFailure(errors[0]);
  return new AggregateError(
    errors.map(fileFailure),
    'Recording file operation and cleanup failed.',
  );
}
