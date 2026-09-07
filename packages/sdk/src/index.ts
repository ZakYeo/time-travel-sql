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
export { decodeTransaction, TRANSACTION_LIMITS } from './domain/events.js';
export type { CommittedTransaction, RowEvent } from './domain/events.js';
export { HistoryState } from './domain/state.js';
export { reconstructionRows } from './application/reconstruction-rows.js';
export {
  decodeReconstructionRequest,
  decodeReconstructionInfo,
} from './domain/reconstruction.js';
export type {
  ReconstructionRequest,
  ReconstructionInfo,
} from './domain/reconstruction.js';
export type {
  CancellationSignal,
  ReconstructionSession,
  HistoryReconstructor,
} from './ports/reconstruction.js';
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
export type { SourceStream, SourceStreamStatus } from './ports/source.js';
export { recordNextCommit } from './application/record-next-commit.js';
export type { SourceBaseline } from './ports/source.js';
export { bootstrapRecording } from './application/bootstrap-recording.js';
export {
  objectFields as decodeDataFields,
  boundedArray as decodeDataArray,
} from './domain/validation.js';
export { decodeCaptureBinding } from './domain/capture-binding.js';
export type { CaptureBinding } from './domain/capture-binding.js';
export type { HistoryCaptureBindings } from './ports/history.js';
export { bootstrapBoundRecording } from './application/bootstrap-recording.js';
export type { SourceCapturePlan } from './ports/source.js';
export { startRecording } from './application/start-recording.js';
export type { RecordingSession } from './ports/recorder.js';
export { restoreRecordingHead } from './application/restore-recording-head.js';
export type {
  SourceResumeLease,
  SourceResumeProvider,
} from './ports/source.js';
export { resumeRecording } from './application/resume-recording.js';
export type {
  RecordingWriteLease,
  RecordingWriteClaim,
  HistoryRecordingOwnership,
} from './ports/history.js';
export { decodeResumableRecording } from './domain/recordings.js';
