import { HistoryError } from '@time-travel-sql/sdk';
import { checkCancelled } from './limits.js';

/** Settle cancellation without taking ownership of a borrowed provider. */
export async function borrowedRead<T>(
  signal: AbortSignal,
  read: () => Promise<T>,
): Promise<T> {
  checkCancelled(signal);
  const cancelled = Promise.withResolvers<never>();
  const abort = () =>
    cancelled.reject(
      new HistoryError('CANCELLED', 'Recording exchange cancelled.'),
    );
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      cancelled.promise,
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
