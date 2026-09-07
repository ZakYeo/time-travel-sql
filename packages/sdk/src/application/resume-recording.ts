import { HistoryError } from '../domain/errors.js';
import { decodeCaptureBinding } from '../domain/capture-binding.js';
import { decodeResumableRecording } from '../domain/recordings.js';
import { identityText } from '../domain/validation.js';
import type {
  HistoryReader,
  HistoryRecordingOwnership,
  RecordingWriteLease,
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
  HistoryRecordingOwnership &
  Pick<HistoryCaptureBindings, 'captureBinding'>;

/** Reserves a durable writer generation before source acquisition, then activates
 * it before restoration. Superseded recorder writes are rejected by storage.
 * Owns both leases and the stream; storage/reconstructor remain caller-owned.
 * Source providers must enforce exclusive acquisition. One attempt, no retry policy.
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
  const claim = await store.prepareRecording(id);
  checkCancelled();
  if (claim.recordingId !== id)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recording writer claim belongs to another recording.',
    );
  const lease = await provider.acquire(expected.recording, binding, signal);
  let writeLease: RecordingWriteLease | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.allSettled([
      Promise.resolve().then(() => writeLease?.close()),
      Promise.resolve().then(() => lease.close()),
    ]).then((results) => {
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new HistoryError(
          'STORAGE_FAILURE',
          'Recording ownership cleanup failed.',
          { cause: new AggregateError(errors) },
        );
    });
    return closing;
  };
  try {
    checkCancelled(lease.signal);
    const writer = await claim.activate();
    writeLease = writer;
    checkCancelled(lease.signal);
    if (writer.recordingId !== id)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Recording writer belongs to another recording.',
      );
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
    const session = await startRecording(
      stream,
      {
        info: (key) => store.info(key),
        append: (key, transaction) => writer.append(key, transaction),
        setStatus: (key, status) => writer.setStatus(key, status),
      },
      id,
    );
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
