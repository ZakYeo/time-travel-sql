import { HistoryError } from './errors.js';
import { decodePosition, comparePositions } from './position.js';
import type { Position } from './position.js';
import {
  objectFields,
  identityText,
  boundedArray,
  utf8Bytes,
} from './validation.js';
import { decodeRow, findTable } from './schema.js';
import type { Schema, Row, RecordingSchema } from './schema.js';

export type RowEvent =
  | Readonly<{ kind: 'insert'; tableId: string; after: Row }>
  | Readonly<{ kind: 'update'; tableId: string; before: Row; after: Row }>
  | Readonly<{ kind: 'delete'; tableId: string; before: Row }>;

export const TRANSACTION_LIMITS = Object.freeze({
  maxEvents: 10000,
  maxBytes: 16 * 1048576,
});

export interface CommittedTransaction {
  /** Exact signed microseconds since Unix epoch; absent in legacy histories. */
  readonly committedAtMicros?: string;
  readonly sourceId: string;
  readonly epochId: string;
  readonly id: string;
  readonly schemaId: string;
  readonly previousPosition: Position;
  readonly position: Position;
  readonly events: readonly RowEvent[];
}

function decodeEvent(schema: Schema, input: unknown): RowEvent {
  const data = objectFields(input, ['kind', 'tableId', 'before', 'after']);
  const tableId = identityText(data.tableId);
  const table = findTable(schema, tableId);
  if (
    data.kind === 'insert' &&
    Object.keys(data).length === 3 &&
    !('before' in data)
  )
    return Object.freeze({
      kind: 'insert',
      tableId,
      after: decodeRow(table, data.after),
    });
  if (
    data.kind === 'delete' &&
    Object.keys(data).length === 3 &&
    !('after' in data)
  )
    return Object.freeze({
      kind: 'delete',
      tableId,
      before: decodeRow(table, data.before),
    });
  if (data.kind === 'update' && Object.keys(data).length === 4)
    return Object.freeze({
      kind: 'update',
      tableId,
      before: decodeRow(table, data.before),
      after: decodeRow(table, data.after),
    });
  throw new HistoryError('INVALID_EVENT', 'Invalid row event.');
}

export function decodeTransaction(
  recording: RecordingSchema,
  input: unknown,
): CommittedTransaction {
  const schema = recording.schema;
  const data = objectFields(input, [
    'id',
    'sourceId',
    'epochId',
    'schemaId',
    'previousPosition',
    'position',
    'events',
    'committedAtMicros',
  ]);
  if (
    data.sourceId !== recording.sourceId ||
    data.epochId !== recording.epochId
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Transaction belongs to a different source or recording epoch.',
    );
  if (data.schemaId !== schema.id)
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Transaction schema does not match the recorded epoch.',
    );
  const previousPosition = decodePosition(data.previousPosition);
  const position = decodePosition(data.position);
  if (comparePositions(previousPosition, position) >= 0)
    throw new HistoryError('INVALID_HISTORY', 'Commit position must advance.');
  const time = data.committedAtMicros;
  if (
    'committedAtMicros' in data &&
    (typeof time !== 'string' || !/^(0|-?[1-9][0-9]{0,29})$/.test(time))
  )
    throw new HistoryError(
      'INVALID_EVENT',
      'Commit time must be canonical signed Unix microseconds.',
    );
  let size = 2;
  const events = boundedArray(data.events, TRANSACTION_LIMITS.maxEvents).map(
    (event) => {
      const decoded = decodeEvent(schema, event);
      size +=
        utf8Bytes(JSON.stringify(decoded), TRANSACTION_LIMITS.maxBytes - size) +
        (size > 2 ? 1 : 0);
      if (size > TRANSACTION_LIMITS.maxBytes)
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'Transaction exceeds the 16 MiB encoded event limit.',
        );
      return decoded;
    },
  );
  return Object.freeze({
    ...(typeof time === 'string' ? { committedAtMicros: time } : {}),
    id: identityText(data.id),
    sourceId: recording.sourceId,
    epochId: recording.epochId,
    schemaId: schema.id,
    previousPosition,
    position,
    events: Object.freeze(events),
  });
}
