import { HistoryError } from '@time-travel-sql/sdk';
import type { CancellationSignal } from '@time-travel-sql/sdk';
import { Client } from './client.js';
import type { Startup } from './protocol.js';

/** Shared lifetime/capacity policy for cancellable read-only worker sessions. */
export class ReadWorkers {
  readonly #sessions = new Set<() => Promise<void>>();
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4)
      throw new HistoryError(
        'INVALID_VALUE',
        'Read worker concurrency must be 1–4.',
      );
  }

  async open(
    startup: Exclude<Startup, { kind: 'store' }>,
    signal?: CancellationSignal,
  ) {
    if (this.#closed || signal?.aborted)
      throw new HistoryError(
        'CANCELLED',
        'Read workers are closed or cancelled.',
      );
    if (this.#sessions.size >= this.capacity)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Close a read session before opening another.',
      );
    const client = new Client(startup);
    const readiness = client.ready.then(
      (value) => ({ ok: true, value }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    let ending: Promise<void> | undefined;
    const abort = () => {
      void close();
    };
    const close = (): Promise<void> => {
      ending ??= (async () => {
        try {
          try {
            signal?.removeEventListener('abort', abort);
          } finally {
            await client.cancel();
          }
        } finally {
          this.#sessions.delete(close);
        }
      })();
      return ending;
    };
    const checkOpen = () => {
      if (this.#closed || ending || signal?.aborted)
        throw new HistoryError(
          'CANCELLED',
          'Read session is closed or cancelled.',
        );
    };
    this.#sessions.add(close);
    try {
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) await close();
      const result = await readiness;
      if (!result.ok) throw result.error;
      checkOpen();
      return { client, ready: result.value, close, checkOpen };
    } catch (error) {
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Read worker startup cleanup failed.',
          { cause: cleanup },
        );
      }
      throw error;
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= (async () => {
      const results = await Promise.allSettled(
        [...this.#sessions].map((close) => close()),
      );
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length)
        throw new HistoryError(
          'STORAGE_FAILURE',
          'Failed to close read workers.',
          { cause: new AggregateError(errors) },
        );
    })();
    return this.#closing;
  }
}
