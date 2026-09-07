import { HistoryError } from '../domain/errors.js';
import {
  decodeRecordingInfo,
  decodeResumableRecording,
} from '../domain/recordings.js';
import type { RecordingInfo, RecordingStatus } from '../domain/recordings.js';
import { decodeRecordingSchema } from '../domain/schema.js';
import { decodePosition } from '../domain/position.js';
import { decodeTransaction } from '../domain/events.js';
import { identityText } from '../domain/validation.js';
import type { HistoryReader, HistoryWriter } from '../ports/history.js';
import type { SourceStream } from '../ports/source.js';
import type { RecordingSession } from '../ports/recorder.js';

type RecorderStore = Pick<HistoryReader, 'info'> &
  Pick<HistoryWriter, 'append' | 'setStatus'>;

function failureStatus(error: unknown): RecordingStatus {
  return error instanceof HistoryError && error.code.startsWith('INVALID_')
    ? 'invalid'
    : 'interrupted';
}

function captureFailure(errors: readonly unknown[]): HistoryError {
  const first = errors[0];
  if (errors.length === 1 && first instanceof HistoryError) return first;
  return new HistoryError(
    'STORAGE_FAILURE',
    'Recording failed; durable history has been retained.',
    {
      cause: errors.length === 1 ? first : new AggregateError(errors),
    },
  );
}

/** Requires exclusive ownership of this recording and a source opened at its durable
 * head. Reconnect policy and lease ownership belong to the composing caller.
 */
export async function startRecording(
  stream: SourceStream,
  store: RecorderStore,
  recordingId: string,
): Promise<RecordingSession> {
  let stopping = false;
  let stopCancelledSource = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(async () => {
      // Already queued failures settle before this microtask. A source that has
      // already entered a terminal state must retain its independent failure.
      const failures: unknown[] = [];
      if (stopping) {
        try {
          const state = stream.status().state;
          stopCancelledSource =
            state === 'streaming' || state === 'waiting-for-durable';
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await stream.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw captureFailure(failures);
    });
    return closing;
  };
  let id: string;
  let recording: ReturnType<typeof decodeRecordingSchema>;
  try {
    id = identityText(recordingId);
    recording = decodeRecordingSchema(stream.recording);
    const info = decodeResumableRecording(await store.info(id));
    const status = stream.status();
    if (
      info.id !== id ||
      JSON.stringify(info.recording) !== JSON.stringify(recording) ||
      decodePosition(status.durablePosition) !== info.headPosition
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Source stream does not match resumable durable recording state.',
      );
    if (status.state === 'closed' || status.state === 'failed')
      throw status.error;
    await store.setStatus(id, 'recording');
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    throw captureFailure(failures);
  }

  const cancelledByStop = (error: unknown): boolean =>
    stopCancelledSource &&
    error instanceof HistoryError &&
    error.code === 'CANCELLED';
  const run = async (): Promise<RecordingInfo> => {
    const failures: unknown[] = [];
    try {
      while (!stopping) {
        let input;
        try {
          input = await stream.next();
        } catch (error) {
          if (cancelledByStop(error)) break;
          throw error;
        }
        if (stopping) break;
        const transaction = decodeTransaction(recording, input);
        // Once accepted, append must settle even if stop closes the source.
        await store.append(id, transaction);
        if (stopping) break;
        try {
          await stream.acknowledge(transaction.position);
        } catch (error) {
          if (cancelledByStop(error)) break;
          throw error;
        }
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    let result: RecordingInfo | undefined;
    try {
      result = decodeRecordingInfo(
        await store.setStatus(
          id,
          failures.length ? failureStatus(failures[0]) : 'stopped',
        ),
      );
    } catch (persistence) {
      failures.push(persistence);
    }
    if (failures.length) throw captureFailure(failures);
    if (!result)
      throw new HistoryError(
        'STORAGE_FAILURE',
        'Recording lifecycle was not persisted.',
      );
    return result;
  };
  const done = run();
  // Keep failures observed until the owner awaits done or stop; neither loses them.
  void done.catch(() => {
    /* The public done promise retains the failure. */
  });
  return Object.freeze({
    done,
    stop() {
      stopping = true;
      void close().catch(() => {
        /* run() retains cleanup failures. */
      });
      return done;
    },
  });
}
