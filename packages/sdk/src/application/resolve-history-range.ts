import { HistoryError } from '../domain/errors.js';
import { comparePositions } from '../domain/position.js';
import type { Position } from '../domain/position.js';
import { decodeRecordingInfo } from '../domain/recordings.js';
import { decodeSelection, selectedPosition } from '../domain/selection.js';
import type { Selection } from '../domain/selection.js';
import type { RecordingExport } from '../ports/export.js';
import type { CancellationSignal } from '../ports/reconstruction.js';

export interface HistoryRange {
  readonly from: Position;
  readonly to: Position;
}

/** Resolve both inclusive endpoints before inspecting any state. The borrowed
 * history session pins endpoint lookups and subsequent replay to one snapshot.
 * Cancellation is checked between reads. Open the session with the same signal
 * to interrupt outstanding reads; this helper does not own or close the session.
 */
export async function resolveHistoryRange(
  history: RecordingExport,
  fromInput: Selection,
  toInput: Selection,
  signal: CancellationSignal,
): Promise<HistoryRange> {
  const check = () => {
    if (signal.aborted)
      throw new HistoryError(
        'CANCELLED',
        'History range resolution cancelled.',
      );
  };
  check();
  const info = decodeRecordingInfo(history.info);
  const fromSelection = decodeSelection(fromInput);
  const toSelection = decodeSelection(toInput);
  const resolve = async (selection: Selection) => {
    check();
    const transaction =
      selection.kind === 'baseline'
        ? undefined
        : await history.transaction(selection.position);
    check();
    return selectedPosition(info, selection, transaction);
  };
  const from = await resolve(fromSelection);
  const to = await resolve(toSelection);
  check();
  if (comparePositions(from, to) > 0)
    throw new HistoryError(
      'INVALID_VALUE',
      'History range starts after its end.',
    );
  return Object.freeze({ from, to });
}
