import { HistoryError } from './errors.js';
import { objectFields } from './validation.js';
import { comparePositions, decodePosition } from './position.js';
import type { Position } from './position.js';
import { decodeRecordingInfo } from './recordings.js';
import type { RecordingInfo } from './recordings.js';
import { decodeTransaction } from './events.js';
import type { CommittedTransaction } from './events.js';

export type Selection =
  | { readonly kind: 'baseline' }
  | { readonly kind: 'before' | 'after'; readonly position: Position };

export function decodeSelection(input: unknown): Selection {
  if (typeof input !== 'object' || input === null || !('kind' in input))
    throw new HistoryError(
      'INVALID_VALUE',
      'Invalid committed-state selection.',
    );
  const descriptor = Object.getOwnPropertyDescriptor(input, 'kind');
  const kind: unknown = descriptor?.value;
  const data = objectFields(
    input,
    kind === 'baseline' ? ['kind'] : ['kind', 'position'],
  );
  if (data.kind === 'baseline') return Object.freeze({ kind: 'baseline' });
  if (data.kind !== 'before' && data.kind !== 'after')
    throw new HistoryError(
      'INVALID_VALUE',
      'Invalid committed-state selection.',
    );
  return Object.freeze({
    kind: data.kind,
    position: decodePosition(data.position),
  });
}

/** Callers obtain the selected commit from recorded history, never a source query. */
export function selectedPosition(
  infoInput: RecordingInfo,
  selectionInput: Selection,
  committed?: CommittedTransaction,
): Position {
  const info = decodeRecordingInfo(infoInput);
  const selection = decodeSelection(selectionInput);
  if (info.baselinePosition === null || info.headPosition === null)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recording has no published baseline.',
    );
  if (selection.kind === 'baseline') return info.baselinePosition;
  const transaction = decodeTransaction(info.recording, committed);
  if (
    transaction.position !== selection.position ||
    comparePositions(transaction.position, info.headPosition) > 0 ||
    comparePositions(transaction.previousPosition, info.baselinePosition) < 0
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Selected transaction is outside recorded coverage.',
    );
  return selection.kind === 'before'
    ? transaction.previousPosition
    : transaction.position;
}
