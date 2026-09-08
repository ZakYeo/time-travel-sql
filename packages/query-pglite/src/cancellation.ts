import { HistoryError } from '@time-travel-sql/sdk';

export function check(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

/** Abandoned borrowed reads remain observed, but cannot delay owned teardown. */
export function cancellable<T>(
  signal: AbortSignal,
  action: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    try {
      action()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    } catch (error) {
      signal.removeEventListener('abort', abort);
      reject(error);
    }
  });
}

export function cancelled(): HistoryError {
  return new HistoryError('CANCELLED', 'Historical query cancelled.');
}
