import { HistoryError } from '../domain/errors.js';
import { HistoryState } from '../domain/state.js';
import {
  decodeRecordingInfo,
  decodeResumableRecording,
} from '../domain/recordings.js';
import type { RecordingInfo, SnapshotRow } from '../domain/recordings.js';
import { decodeTransaction } from '../domain/events.js';
import { decodeReconstructionInfo } from '../domain/reconstruction.js';
import { selectedPosition } from '../domain/selection.js';
import type { Selection } from '../domain/selection.js';
import { identityText } from '../domain/validation.js';
import type { HistoryReader } from '../ports/history.js';
import type {
  CancellationSignal,
  HistoryReconstructor,
} from '../ports/reconstruction.js';
import { reconstructionRows } from './reconstruction-rows.js';

/** Restores resumable state solely from durable history. The caller must hold
 * exclusive recording ownership; metadata rechecks are not a concurrency lock.
 * Owns the opened session, but not the reader or reconstructor.
 */
export async function restoreRecordingHead(
  reader: Pick<HistoryReader, 'info' | 'transaction'>,
  reconstructor: HistoryReconstructor,
  recordingId: string,
  signal?: CancellationSignal,
): Promise<{ readonly info: RecordingInfo; readonly state: HistoryState }> {
  const checkCancelled = (): void => {
    if (signal?.aborted)
      throw new HistoryError(
        'CANCELLED',
        'Recording head restoration was cancelled.',
      );
  };
  checkCancelled();
  const id = identityText(recordingId);
  const info = decodeResumableRecording(await reader.info(id));
  checkCancelled();
  if (info.id !== id)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recording has no resumable durable head.',
    );
  const last =
    info.transactionCount === 0
      ? undefined
      : decodeTransaction(
          info.recording,
          await reader.transaction(id, info.headPosition),
        );
  checkCancelled();
  const selection: Selection = last
    ? { kind: 'before', position: info.headPosition }
    : { kind: 'baseline' };
  const position = selectedPosition(info, selection, last);
  const session = await reconstructor.open(
    { recordingId: id, selection },
    signal,
  );
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(() => session.close());
    return closing;
  };
  const abort = () => {
    void close().catch(() => {
      /* The owner awaits the same cleanup promise. */
    });
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkCancelled();
    const snapshot = decodeReconstructionInfo(session.info);
    if (
      snapshot.position !== position ||
      JSON.stringify(snapshot.selection) !== JSON.stringify(selection) ||
      JSON.stringify(snapshot.recording) !== JSON.stringify(info)
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Reconstruction does not match the durable recording head.',
      );
    const rows: SnapshotRow[] = [];
    // Pin the validated metadata even if a custom session exposes mutable fields.
    for await (const row of reconstructionRows({
      info: snapshot,
      rows: (table, page) => session.rows(table, page),
    })) {
      checkCancelled();
      rows.push(row);
    }
    await close();
    checkCancelled();
    let state = HistoryState.fromSnapshot(
      info.recording,
      position,
      rows,
      snapshot.limits,
    );
    if (last) state = state.apply(last);
    const current = decodeRecordingInfo(await reader.info(id));
    checkCancelled();
    if (
      state.position !== info.headPosition ||
      JSON.stringify(current) !== JSON.stringify(info)
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Recording changed while its durable head was restored.',
      );
    return Object.freeze({ info, state });
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      if (cleanup !== error)
        throw new HistoryError(
          'STORAGE_FAILURE',
          'Recording restoration and cleanup failed.',
          { cause: new AggregateError([error, cleanup]) },
        );
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
