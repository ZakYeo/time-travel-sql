import { isAbsolute } from 'node:path';
import {
  HistoryError,
  decodeReconstructionRequest,
  decodeReconstructionInfo,
  decodeReplayLimits,
  DEFAULT_REPLAY_LIMITS,
} from '@time-travel-sql/sdk';
import type { HistoryReconstructor, ReplayLimits } from '@time-travel-sql/sdk';
import { Client } from './client.js';

export interface LocalReconstructionOptions {
  readonly path: string;
  readonly replayLimits?: ReplayLimits;
  /** Maximum simultaneously owned workers, including pending opens. Defaults to 2. */
  readonly maxConcurrent?: number;
}

export function createLocalReconstructor(
  options: LocalReconstructionOptions,
): HistoryReconstructor {
  if (typeof options.path !== 'string' || !isAbsolute(options.path))
    throw new HistoryError(
      'INVALID_VALUE',
      'Reconstruction requires an absolute file path.',
    );
  const workerOptions = {
    path: options.path,
    replayLimits: decodeReplayLimits(
      options.replayLimits ?? DEFAULT_REPLAY_LIMITS,
    ),
  };
  const capacity = options.maxConcurrent ?? 2;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4)
    throw new HistoryError(
      'INVALID_VALUE',
      'Reconstruction concurrency must be 1–4.',
    );
  const sessions = new Set<() => Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  return {
    async open(input, signal) {
      const request = decodeReconstructionRequest(input);
      if (closed || signal?.aborted)
        throw new HistoryError(
          'CANCELLED',
          'Historical reconstruction is closed or cancelled.',
        );
      if (sessions.size >= capacity)
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'Close a reconstruction session before opening another.',
        );
      const client = new Client({
        kind: 'reconstruction',
        options: workerOptions,
        request,
      });
      // Attach both outcomes before cancellation can reject startup readiness.
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
            signal?.removeEventListener('abort', abort);
          } finally {
            try {
              await client.cancel();
            } finally {
              sessions.delete(close);
            }
          }
        })();
        return ending;
      };
      sessions.add(close);
      try {
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) await close();
        const result = await readiness;
        if (!result.ok) throw result.error;
        const info = decodeReconstructionInfo(result.value);
        if (closed || ending || signal?.aborted)
          throw new HistoryError(
            'CANCELLED',
            'Historical reconstruction was cancelled.',
          );
        return {
          info,
          async rows(tableId, page) {
            if (ending || signal?.aborted)
              throw new HistoryError(
                'CANCELLED',
                'Reconstruction session is closed or cancelled.',
              );
            return client.request({
              method: 'reconstructionRows',
              args: [tableId, page],
            });
          },
          close,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
    close() {
      closed = true;
      closing ??= (async () => {
        const results = await Promise.allSettled(
          [...sessions].map((close) => close()),
        );
        const failures = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason);
        if (failures.length)
          throw new HistoryError(
            'STORAGE_FAILURE',
            'Failed to close historical reconstruction workers.',
            { cause: new AggregateError(failures) },
          );
      })();
      return closing;
    },
  };
}
