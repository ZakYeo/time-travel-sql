import { HistoryError } from './errors.js';
import { decodeRecordingSchema, decodeRow, findTable } from './schema.js';
import type { RecordingSchema, Row } from './schema.js';
import { decodePosition, comparePositions } from './position.js';
import type { Position } from './position.js';
import { boundedText, identityText, objectFields } from './validation.js';
import { canonicalTimestamp } from './temporal.js';

export interface RecordingMetadata {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly recording: RecordingSchema;
}
export type RecordingStatus =
  | 'bootstrapping'
  | 'recording'
  | 'stopped'
  | 'interrupted'
  | 'invalid';
export interface RecordingInfo extends RecordingMetadata {
  readonly status: RecordingStatus;
  readonly baselinePosition: Position | null;
  readonly baselineRowCount: number | null;
  readonly baselineChecksum: string | null;
  readonly headPosition: Position | null;
  readonly transactionCount: number;
}
export interface SnapshotRow {
  readonly tableId: string;
  readonly row: Row;
}

export interface ResumableRecordingInfo extends RecordingInfo {
  readonly status: 'recording' | 'stopped' | 'interrupted';
  readonly baselinePosition: Position;
  readonly headPosition: Position;
}

export function decodeResumableRecording(
  input: unknown,
): ResumableRecordingInfo {
  const info = decodeRecordingInfo(input);
  const { status, baselinePosition, headPosition } = info;
  if (
    info.recording.derivation !== undefined ||
    status === 'invalid' ||
    status === 'bootstrapping' ||
    baselinePosition === null ||
    headPosition === null
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recording has no resumable durable head.',
    );
  return Object.freeze({ ...info, status, baselinePosition, headPosition });
}
export interface PageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export function decodeRecordingMetadata(input: unknown): RecordingMetadata {
  const data = objectFields(input, ['id', 'name', 'createdAt', 'recording']);
  const name = boundedText(data.name, 256);
  if (!name.trim())
    throw new HistoryError(
      'INVALID_VALUE',
      'Recording name must not be empty.',
    );
  return Object.freeze({
    id: identityText(data.id),
    name,
    createdAt: canonicalTimestamp(boundedText(data.createdAt, 40), true),
    recording: decodeRecordingSchema(data.recording),
  });
}

export function decodeRecordingInfo(input: unknown): RecordingInfo {
  const data = objectFields(input, [
    'id',
    'name',
    'createdAt',
    'recording',
    'status',
    'baselinePosition',
    'baselineRowCount',
    'baselineChecksum',
    'headPosition',
    'transactionCount',
  ]);
  const metadata = decodeRecordingMetadata({
    id: data.id,
    name: data.name,
    createdAt: data.createdAt,
    recording: data.recording,
  });
  const status = data.status;
  if (
    status !== 'bootstrapping' &&
    status !== 'recording' &&
    status !== 'stopped' &&
    status !== 'interrupted' &&
    status !== 'invalid'
  )
    throw new HistoryError('INVALID_HISTORY', 'Invalid recording lifecycle.');
  const baselinePosition =
    data.baselinePosition === null
      ? null
      : decodePosition(data.baselinePosition);
  const headPosition =
    data.headPosition === null ? null : decodePosition(data.headPosition);
  const baselineRowCount = data.baselineRowCount;
  const baselineChecksum = data.baselineChecksum;
  if (
    baselineRowCount !== null &&
    (typeof baselineRowCount !== 'number' ||
      !Number.isSafeInteger(baselineRowCount) ||
      baselineRowCount < 0)
  )
    throw new HistoryError('INVALID_HISTORY', 'Invalid baseline row count.');
  if (
    baselineChecksum !== null &&
    (typeof baselineChecksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(baselineChecksum))
  )
    throw new HistoryError('INVALID_HISTORY', 'Invalid baseline checksum.');
  if (
    typeof data.transactionCount !== 'number' ||
    !Number.isSafeInteger(data.transactionCount) ||
    data.transactionCount < 0
  )
    throw new HistoryError('INVALID_HISTORY', 'Invalid transaction count.');
  if (baselinePosition === null || headPosition === null) {
    if (
      baselinePosition !== headPosition ||
      baselineRowCount !== null ||
      baselineChecksum !== null ||
      data.transactionCount !== 0 ||
      (status !== 'bootstrapping' && status !== 'invalid')
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Unpublished recordings cannot contain committed progress.',
      );
  } else {
    const order = comparePositions(baselinePosition, headPosition);
    if (
      status === 'bootstrapping' ||
      baselineRowCount === null ||
      baselineChecksum === null ||
      order > 0 ||
      (order === 0) !== (data.transactionCount === 0)
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Published coverage contradicts its lifecycle or transaction count.',
      );
  }
  return Object.freeze({
    ...metadata,
    status,
    baselinePosition,
    baselineRowCount,
    baselineChecksum,
    headPosition,
    transactionCount: data.transactionCount,
  });
}

export function decodeSnapshotRow(
  recording: RecordingSchema,
  input: unknown,
): SnapshotRow {
  const data = objectFields(input, ['tableId', 'row']);
  const tableId = identityText(data.tableId);
  return Object.freeze({
    tableId,
    row: decodeRow(findTable(recording.schema, tableId), data.row),
  });
}

export function decodePageRequest(input: unknown): PageRequest {
  const data = objectFields(input, ['cursor', 'limit']);
  if (
    typeof data.limit !== 'number' ||
    !Number.isInteger(data.limit) ||
    data.limit < 1 ||
    data.limit > 100
  )
    throw new HistoryError('LIMIT_EXCEEDED', 'Page size must be 1–100.');
  return Object.freeze({
    cursor: data.cursor === null ? null : boundedText(data.cursor, 65536),
    limit: data.limit,
  });
}

export function validateStatusChange(
  current: RecordingStatus,
  next: RecordingStatus,
): void {
  const transitions: Readonly<
    Record<RecordingStatus, readonly RecordingStatus[]>
  > = {
    bootstrapping: ['invalid'],
    recording: ['stopped', 'interrupted', 'invalid'],
    stopped: ['recording', 'invalid'],
    interrupted: ['recording', 'invalid'],
    invalid: [],
  };
  if (current !== next && !transitions[current].includes(next))
    throw new HistoryError(
      'INVALID_HISTORY',
      'Invalid recording lifecycle transition.',
    );
}
