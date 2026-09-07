import { readPostgresCaptureBinding } from './capture-binding.js';
import { openPostgresCaptureLease } from './capture-lease.js';
import { openPostgresStream } from './stream.js';
import type { PostgresConnection } from './connection.js';
import type { SourceResumeProvider, HistoryState } from '@time-travel-sql/sdk';

/** Explicit runtime credentials; the persisted binding contains only setup identity. */
export function createPostgresResumeProvider(
  input: PostgresConnection,
): SourceResumeProvider {
  const connection = { ...input };
  return Object.freeze({
    async acquire(recording, binding, signal) {
      const receipt = readPostgresCaptureBinding(recording, binding);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) abort();
        const lease = await openPostgresCaptureLease(
          connection,
          receipt,
          controller.signal,
        );
        return Object.freeze({
          signal: lease.signal,
          openStream: (state: HistoryState) =>
            openPostgresStream({
              ...receipt,
              connection,
              lease,
              state,
              signal: lease.signal,
            }),
          async close() {
            signal?.removeEventListener('abort', abort);
            await lease.close();
          },
        });
      } catch (error) {
        signal?.removeEventListener('abort', abort);
        throw error;
      }
    },
  } satisfies SourceResumeProvider);
}
