import { HistoryError } from './errors.js';
import { comparePositions, decodePosition } from './position.js';
import type { Position } from './position.js';
import type { RecordingInfo } from './recordings.js';
import { objectFields, identityText } from './validation.js';

export interface CheckpointInfo {
  readonly version: 1;
  readonly recordingId: string;
  readonly sourceId: string;
  readonly epochId: string;
  readonly schemaId: string;
  readonly position: Position;
  readonly transactionCount: number;
  readonly rowCount: number;
  readonly checksum: string;
  readonly historyChecksum: string;
}

export function decodeCheckpointInfo(
  info: RecordingInfo,
  input: unknown,
): CheckpointInfo {
  const data = objectFields(input, [
    'version',
    'recordingId',
    'sourceId',
    'epochId',
    'schemaId',
    'position',
    'transactionCount',
    'rowCount',
    'checksum',
    'historyChecksum',
  ]);
  const recordingId = identityText(data.recordingId);
  const sourceId = identityText(data.sourceId);
  const epochId = identityText(data.epochId);
  const schemaId = identityText(data.schemaId);
  const position = decodePosition(data.position);
  if (
    data.version !== 1 ||
    recordingId !== info.id ||
    sourceId !== info.recording.sourceId ||
    epochId !== info.recording.epochId ||
    schemaId !== info.recording.schema.id ||
    info.baselinePosition === null ||
    info.headPosition === null ||
    comparePositions(position, info.baselinePosition) < 0 ||
    comparePositions(position, info.headPosition) > 0
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Checkpoint identity or position is incompatible with recorded history.',
    );
  if (
    typeof data.transactionCount !== 'number' ||
    !Number.isSafeInteger(data.transactionCount) ||
    data.transactionCount < 0 ||
    data.transactionCount > info.transactionCount ||
    typeof data.rowCount !== 'number' ||
    !Number.isSafeInteger(data.rowCount) ||
    data.rowCount < 0 ||
    typeof data.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.checksum) ||
    typeof data.historyChecksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.historyChecksum)
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Checkpoint counts or integrity metadata are invalid.',
    );
  if ((position === info.baselinePosition) !== (data.transactionCount === 0))
    throw new HistoryError(
      'INVALID_HISTORY',
      'Checkpoint count contradicts its position.',
    );
  return Object.freeze({
    version: 1,
    recordingId,
    sourceId,
    epochId,
    schemaId,
    position,
    transactionCount: data.transactionCount,
    rowCount: data.rowCount,
    checksum: data.checksum,
    historyChecksum: data.historyChecksum,
  });
}
