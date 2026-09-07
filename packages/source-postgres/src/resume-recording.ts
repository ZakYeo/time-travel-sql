import {
  HistoryError,
  decodeStableId,
  resumeRecording,
} from '@time-travel-sql/sdk';
import type {
  HistoryReconstructor,
  RecordingInfo,
  RecordingSession,
  ResumeStore,
} from '@time-travel-sql/sdk';
import type { PostgresConnection } from './connection.js';
import { createPostgresResumeProvider } from './resume-provider.js';
import { reconnectPolicy, waitForRetry } from './reconnect-policy.js';
import type {
  PostgresReconnectOptions,
  PostgresRecordingSession,
  PostgresRecordingStatus,
} from './reconnect-policy.js';

/** Owns sequential resume attempts, their cleanup and bounded retry backoff.
 * Only explicit SOURCE_UNAVAILABLE failures retry. Never allocates replacement resources.
 */
export function resumePostgresRecording(
  store: ResumeStore,
  reconstructor: HistoryReconstructor,
  connection: PostgresConnection,
  recordingId: string,
  options: PostgresReconnectOptions = {},
): PostgresRecordingSession {
  const id = decodeStableId(recordingId);
  const policy = reconnectPolicy(options);
  const provider = createPostgresResumeProvider(connection);
  const controller = new AbortController();
  const external = options.signal;
  const abort = () => controller.abort();
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) abort();
  let active: RecordingSession | undefined;
  let stopping = false;
  let stopCancelled = false;
  let phase: PostgresRecordingStatus['phase'] = 'starting';
  let retries = 0;
  let lastFailure: PostgresRecordingStatus['lastFailure'] = null;
  const run = async (): Promise<RecordingInfo> => {
    while (true) {
      try {
        if (controller.signal.aborted)
          throw new HistoryError(
            'CANCELLED',
            'PostgreSQL recording was cancelled.',
          );
        phase = 'starting';
        active = await resumeRecording(
          store,
          reconstructor,
          provider,
          id,
          controller.signal,
        );
        phase = 'recording';
        if (stopping) void active.stop();
        return await active.done;
      } catch (error) {
        const wasRecording = active !== undefined;
        active = undefined;
        if (
          stopCancelled &&
          !wasRecording &&
          !external?.aborted &&
          error instanceof HistoryError &&
          error.code === 'CANCELLED'
        )
          return store.info(id);
        if (
          !(error instanceof HistoryError) ||
          error.code !== 'SOURCE_UNAVAILABLE' ||
          stopping ||
          external?.aborted ||
          retries >= policy.maxRetries
        )
          throw error;
        retries++;
        lastFailure = Object.freeze({
          code: error.code,
          message: error.message,
        });
        phase = 'waiting-to-retry';
        try {
          await waitForRetry(policy.delay(retries), controller.signal);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          if (stopCancelled && !external?.aborted) return store.info(id);
          throw new HistoryError(
            'CANCELLED',
            'PostgreSQL recording was cancelled.',
          );
        }
      } finally {
        active = undefined;
      }
    }
  };
  const done = run()
    .then(
      (info) => {
        phase = 'stopped';
        return info;
      },
      (error: unknown) => {
        phase = 'failed';
        lastFailure = Object.freeze(
          error instanceof HistoryError
            ? { code: error.code, message: error.message }
            : {
                code: 'STORAGE_FAILURE',
                message: 'PostgreSQL recording failed.',
              },
        );
        throw error;
      },
    )
    .finally(() => external?.removeEventListener('abort', abort));
  void done.catch(() => {
    /* The public promise retains terminal errors. */
  });
  return Object.freeze({
    done,
    stop() {
      if (!stopping) {
        stopping = true;
        // Let already queued failures settle before claiming cancellation ownership.
        void Promise.resolve().then(() => {
          if (active) void active.stop();
          else if (phase === 'starting' || phase === 'waiting-to-retry') {
            stopCancelled = !controller.signal.aborted && !external?.aborted;
            controller.abort();
          }
        });
      }
      return done;
    },
    status: () => Object.freeze({ phase, retries, lastFailure }),
  });
}
