import { HistoryError } from './errors.js';
import { decodeRecordingInfo } from './recordings.js';
import type { RecordingInfo } from './recordings.js';
import { decodeSelection } from './selection.js';
import type { Selection } from './selection.js';
import { comparePositions, decodePosition } from './position.js';
import type { Position } from './position.js';
import { decodeReplayLimits, checkReplaySize } from './replay-limits.js';
import type { ReplayLimits } from './replay-limits.js';
import { identityText, objectFields } from './validation.js';

export interface ReconstructionRequest {
  readonly recordingId: string;
  readonly selection: Selection;
}

export interface ReconstructionInfo {
  readonly recording: RecordingInfo;
  readonly selection: Selection;
  readonly position: Position;
  readonly rowCount: number;
  readonly retainedBytes: number;
  readonly limits: ReplayLimits;
}

export function decodeReconstructionRequest(
  input: unknown,
): ReconstructionRequest {
  const value = objectFields(input, ['recordingId', 'selection']);
  return Object.freeze({
    recordingId: identityText(value.recordingId),
    selection: decodeSelection(value.selection),
  });
}

export function decodeReconstructionInfo(input: unknown): ReconstructionInfo {
  const value = objectFields(input, [
    'recording',
    'selection',
    'position',
    'rowCount',
    'retainedBytes',
    'limits',
  ]);
  const recording = decodeRecordingInfo(value.recording);
  const selection = decodeSelection(value.selection);
  const position = decodePosition(value.position);
  const limits = decodeReplayLimits(value.limits);
  if (
    recording.baselinePosition === null ||
    recording.headPosition === null ||
    comparePositions(position, recording.baselinePosition) < 0 ||
    comparePositions(position, recording.headPosition) > 0
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Reconstruction is outside published coverage.',
    );
  if (
    (selection.kind === 'baseline' &&
      position !== recording.baselinePosition) ||
    (selection.kind === 'after' && position !== selection.position) ||
    (selection.kind === 'before' &&
      (comparePositions(position, selection.position) >= 0 ||
        comparePositions(selection.position, recording.headPosition) > 0))
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Reconstruction does not match its selection.',
    );
  const { rowCount, retainedBytes } = value;
  if (
    typeof rowCount !== 'number' ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0 ||
    typeof retainedBytes !== 'number' ||
    !Number.isSafeInteger(retainedBytes) ||
    retainedBytes < 0 ||
    (rowCount === 0) !== (retainedBytes === 0)
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Invalid reconstructed state size.',
    );
  checkReplaySize(limits, rowCount, retainedBytes);
  return Object.freeze({
    recording,
    selection,
    position,
    rowCount,
    retainedBytes,
    limits,
  });
}
