export { HistoryError } from './domain/errors.js';
export type { ErrorCode } from './domain/errors.js';
export { decodePosition, comparePositions } from './domain/position.js';
export type { Position } from './domain/position.js';
export {
  scalarValue,
  decodeValue,
  valueIdentity,
  decodeScalarType,
} from './domain/values.js';
export type { Value, ScalarValue, ScalarType } from './domain/values.js';
export {
  decodeSchema,
  decodeRecordingSchema,
  decodeRow,
  rowKey,
} from './domain/schema.js';
export type {
  Schema,
  RecordingSchema,
  TableSchema,
  ColumnSchema,
  Row,
} from './domain/schema.js';
export { decodeTransaction } from './domain/events.js';
export type { CommittedTransaction, RowEvent } from './domain/events.js';
export { HistoryState } from './domain/state.js';
export {
  decodeReplayLimits,
  DEFAULT_REPLAY_LIMITS,
} from './domain/replay-limits.js';
export type { ReplayLimits } from './domain/replay-limits.js';
export { decodeSelection, selectedPosition } from './domain/selection.js';
export type { Selection } from './domain/selection.js';
export { decodeCheckpointInfo } from './domain/checkpoints.js';
export type { CheckpointInfo } from './domain/checkpoints.js';
export {
  decodeRecordingMetadata,
  decodeRecordingInfo,
  decodeSnapshotRow,
  decodePageRequest,
  validateStatusChange,
} from './domain/recordings.js';
export type {
  RecordingMetadata,
  RecordingInfo,
  RecordingStatus,
  SnapshotRow,
  PageRequest,
  Page,
} from './domain/recordings.js';
export { identityText as decodeStableId } from './domain/validation.js';
export type {
  HistoryWriter,
  HistoryReader,
  RecordingManagement,
  HistoryCheckpoints,
} from './ports/history.js';
