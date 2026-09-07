import { HistoryError } from '@time-travel-sql/sdk';

// Explicit transport/server availability codes; authentication, protocol, resource,
// schema and continuity failures are not retryable. Prefer stable error codes.
const transientCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  '08000',
  '08001',
  '08003',
  '08006',
  '57P01',
  '57P02',
  '57P03',
]);

// pg 8.23 emits these codeless errors for socket EOF and its connection deadline.
// Keep this compatibility list narrow and covered by real transport fixtures.
const driverTransportMessages = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated',
  'timeout expired',
  'Connection terminated due to connection timeout',
]);

export function postgresFailure(error: unknown, message: string): HistoryError {
  if (error instanceof HistoryError) return error;
  const transient =
    error instanceof Error &&
    (('code' in error &&
      typeof error.code === 'string' &&
      transientCodes.has(error.code)) ||
      (!('code' in error) &&
        error.name === 'Error' &&
        driverTransportMessages.has(error.message)));
  return new HistoryError(
    transient ? 'SOURCE_UNAVAILABLE' : 'STORAGE_FAILURE',
    message,
    { cause: error },
  );
}

export function postgresCancellation(signal: AbortSignal): HistoryError {
  return signal.reason instanceof HistoryError
    ? signal.reason
    : new HistoryError('CANCELLED', 'PostgreSQL operation was cancelled.');
}
