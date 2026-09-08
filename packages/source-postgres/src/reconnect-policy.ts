import { HistoryError } from '@time-travel-sql/sdk';
import type { RecordingInfo, CaptureBinding } from '@time-travel-sql/sdk';

export interface PostgresReconnectOptions {
  readonly signal?: AbortSignal;
  /** Pin an explicitly selected recording/source binding across acquisition and retries. */
  readonly expectedBinding?: CaptureBinding;
  /** Total retries over this supervisor's lifetime; default 5, maximum 20. */
  readonly maxRetries?: number;
  /** Exponential delay starts here; default 250 ms. */
  readonly initialDelayMs?: number;
  /** Delay cap; default 5000 ms, maximum 60000 ms. */
  readonly maxDelayMs?: number;
}
export interface PostgresRecordingStatus {
  readonly phase:
    | 'starting'
    | 'recording'
    | 'waiting-to-retry'
    | 'stopped'
    | 'failed';
  readonly retries: number;
  readonly lastFailure: {
    readonly code: string;
    readonly message: string;
  } | null;
}
export interface PostgresRecordingSession {
  readonly done: Promise<RecordingInfo>;
  /** Drains active recording or cancels startup/backoff. Without an active writer,
   * returns the existing durable info without rewriting its lifecycle status.
   */
  stop(): Promise<RecordingInfo>;
  status(): PostgresRecordingStatus;
}

export function reconnectPolicy(options: PostgresReconnectOptions) {
  const maxRetries = options.maxRetries ?? 5;
  const initialDelayMs = options.initialDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  if (
    !Number.isInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > 20 ||
    !Number.isInteger(initialDelayMs) ||
    initialDelayMs < 1 ||
    !Number.isInteger(maxDelayMs) ||
    maxDelayMs < initialDelayMs ||
    maxDelayMs > 60000
  )
    throw new HistoryError(
      'INVALID_VALUE',
      'Reconnect requires 0–20 retries and delays between 1 and 60000 ms.',
    );
  return Object.freeze({
    maxRetries,
    delay: (retry: number) =>
      Math.min(initialDelayMs * 2 ** (retry - 1), maxDelayMs),
  });
}

/** Owns one delay and removes its abort listener on every outcome. */
export function waitForRetry(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(
        new HistoryError('CANCELLED', 'PostgreSQL recording was cancelled.'),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
