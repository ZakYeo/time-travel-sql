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
