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
  findTable,
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
export type { SnapshotAccumulator } from './domain/state.js';
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
  ReconstructionView,
  ReconstructionPair,
  HistoryStatePairs,
} from './ports/reconstruction.js';
export {
  decodeReplayLimits,
  DEFAULT_REPLAY_LIMITS,
} from './domain/replay-limits.js';
export type { ReplayLimits } from './domain/replay-limits.js';
export { decodeSelection, selectedPosition } from './domain/selection.js';
export type { Selection } from './domain/selection.js';
export { resolveHistoryRange } from './application/resolve-history-range.js';
export type { HistoryRange } from './application/resolve-history-range.js';
export { scanInvariant } from './application/scan-invariant.js';
export type {
  InvariantScanRequest,
  ScanOutcome,
} from './application/scan-invariant.js';
export type { ScanControl, ScanProgress } from './application/scan-work.js';
export {
  decodeScanLimits,
  DEFAULT_SCAN_LIMITS,
  MAX_SCAN_LIMITS,
} from './domain/invariant.js';
export type { ScanLimits } from './domain/invariant.js';
export { decodeSavedCheck } from './domain/saved-check.js';
export type { SavedCheck } from './domain/saved-check.js';
export type {
  SavedChecks,
  SavedCheckHistory,
  SavedCheckHistories,
} from './ports/saved-checks.js';
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

export type { ResumeStore } from './application/resume-recording.js';
export type { HistoryImports, RecordingImport } from './ports/import.js';
export {
  decodeRecordingManifest,
  HISTORY_WORK_LIMITS,
} from './domain/recording-manifest.js';
export type { RecordingManifest } from './domain/recording-manifest.js';
export type {
  RecordingExport,
  RecordingExportView,
  HistoryExports,
} from './ports/export.js';
export { inspectReconstructedRows } from './application/inspect-reconstructed-rows.js';
export { compareReconstructedStates } from './application/compare-reconstructed-states.js';
export {
  decodeInvestigationOptions,
  DEFAULT_INVESTIGATION_OPTIONS,
} from './domain/investigation.js';
export type {
  InvestigationOptions,
  KeyedRow,
  RowDifference,
  FieldDifference,
} from './domain/investigation.js';
export type { InvestigationControl } from './application/investigation-work.js';
export {
  decodeQueryLimits,
  decodeQueryRequest,
  DEFAULT_QUERY_LIMITS,
  MAX_QUERY_LIMITS,
} from './domain/query.js';
export type {
  QueryLimits,
  QueryRequest,
  QueryColumn,
  QueryResult,
} from './domain/query.js';
export { QueryResultBuffer } from './domain/query-result.js';
export type { HistoricalQueryEngine } from './ports/query.js';
export { inspectRowHistory } from './application/inspect-row-history.js';
export type { RowHistoryRequest } from './application/inspect-row-history.js';
export {
  decodeRowHistoryOptions,
  DEFAULT_ROW_HISTORY_OPTIONS,
  MAX_ROW_HISTORY_OPTIONS,
} from './domain/row-history.js';
export type {
  RowHistoryOptions,
  RowHistoryEntry,
  RowOrigin,
} from './domain/row-history.js';
export {
  decodeColumnPolicy,
  applyColumnPolicy,
  recordedColumnPolicy,
  schemaWithoutColumnPolicy,
  projectRow,
  projectTransaction,
} from './domain/column-policy.js';
export type { ColumnPolicy, ColumnRule } from './domain/column-policy.js';
export {
  DERIVED_CAPABILITIES,
  decodeRecordingDerivation,
} from './domain/derivation.js';
export type { RecordingDerivation } from './domain/derivation.js';
