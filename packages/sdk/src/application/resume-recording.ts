import { HistoryError } from '../domain/errors.js';
import { decodeCaptureBinding } from '../domain/capture-binding.js';
import { decodeResumableRecording } from '../domain/recordings.js';
import { identityText } from '../domain/validation.js';
import type {
  HistoryReader,
  HistoryWriter,
  HistoryCaptureBindings,
} from '../ports/history.js';
import type {
  HistoryReconstructor,
  CancellationSignal,
} from '../ports/reconstruction.js';
import type { RecordingSession } from '../ports/recorder.js';
import type { SourceResumeProvider } from '../ports/source.js';
import { restoreRecordingHead } from './restore-recording-head.js';
import { startRecording } from './start-recording.js';

type ResumeStore = Pick<HistoryReader, 'info' | 'transaction'> &
  Pick<HistoryWriter, 'append' | 'setStatus'> &
  Pick<HistoryCaptureBindings, 'captureBinding'>;

/** Requires exclusive LOCAL recording ownership from before invocation through done.
 * Source lease loss can precede completion of an accepted local append, so source
 * ownership alone cannot exclude overlapping recorders. Owns the acquired source
 * lease and stream; storage and reconstructor remain caller-owned. One attempt.
 */
export async function resumeRecording(
  store: ResumeStore,
  reconstructor: HistoryReconstructor,
  provider: SourceResumeProvider,
  recordingId: string,
  signal?: CancellationSignal,
): Promise<RecordingSession> {
  const checkCancelled = (owned?: CancellationSignal): void => {
    if (signal?.aborted || owned?.aborted)
      throw new HistoryError('CANCELLED', 'Recording resume was cancelled.');
  };
  checkCancelled();
  const id = identityText(recordingId);
  const expected = decodeResumableRecording(await store.info(id));
  if (expected.id !== id)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recording identity differs from the requested resume.',
    );
  const savedBinding = await store.captureBinding(id);
  if (savedBinding === null)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recording has no source binding for resume.',
    );
  const binding = decodeCaptureBinding(savedBinding);
  checkCancelled();
  const lease = await provider.acquire(expected.recording, binding, signal);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(() => lease.close());
    return closing;
  };
  try {
    checkCancelled(lease.signal);
    const restored = await restoreRecordingHead(
      store,
      reconstructor,
      id,
      lease.signal,
    );
    const currentBinding = decodeCaptureBinding(await store.captureBinding(id));
    checkCancelled(lease.signal);
    if (
      JSON.stringify(restored.info.recording) !==
        JSON.stringify(expected.recording) ||
      JSON.stringify(currentBinding) !== JSON.stringify(binding)
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Recording identity or binding changed during source acquisition.',
      );
    const stream = await lease.openStream(restored.state);
    // startRecording owns this stream, including its startup failure cleanup.
    const session = await startRecording(stream, store, id);
    const done = (async () => {
      const outcome = await session.done.then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
      try {
        await close();
      } catch (cleanup) {
        throw new HistoryError(
          'STORAGE_FAILURE',
          'Recording source ownership could not be released.',
          {
            cause: outcome.ok
              ? cleanup
              : new AggregateError([outcome.error, cleanup]),
          },
        );
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    })();
    void done.catch(() => {
      /* The public completion promise retains failures. */
    });
    return Object.freeze({
      done,
      stop() {
        void session.stop();
        return done;
      },
    });
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new HistoryError(
        'STORAGE_FAILURE',
        'Recording resume and source cleanup failed.',
        { cause: new AggregateError([error, cleanup]) },
      );
    }
    throw error;
  }
}
