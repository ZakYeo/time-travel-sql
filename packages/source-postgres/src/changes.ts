import {
  HistoryError,
  decodeRow,
  rowKey,
  scalarValue,
} from '@time-travel-sql/sdk';
import type {
  RecordingSchema,
  TableSchema,
  Row,
  RowEvent,
  Value,
} from '@time-travel-sql/sdk';
import type { Pgoutput } from 'pg-logical-replication';
import { postgresTableId } from './schema.js';
import { postgresScalarType } from './scalar-types.js';

type Change =
  | Pgoutput.MessageInsert
  | Pgoutput.MessageUpdate
  | Pgoutput.MessageDelete;

/** Check each relation use: the transport library replaces cached relation objects. */
export function postgresRelation(
  recording: RecordingSchema,
  relation: Pgoutput.MessageRelation,
): TableSchema {
  const id = postgresTableId(String(relation.relationOid));
  const table = recording.schema.tables.find((table) => table.id === id);
  if (
    !table ||
    table.namespace !== relation.schema ||
    table.name !== relation.name ||
    relation.replicaIdentity !== 'full' ||
    relation.columns.length !== table.columns.length ||
    relation.columns.some((column, index) => {
      const expected = table.columns[index];
      return (
        !expected ||
        expected.name !== column.name ||
        expected.type !== postgresScalarType(column.typeOid) ||
        expected.typeModifier !== column.typeMod
      );
    })
  )
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Replication relation differs from the recorded schema.',
    );
  return table;
}

function tuple(
  table: TableSchema,
  input: Readonly<Record<string, unknown>>,
): readonly unknown[] {
  if (Object.keys(input).length !== table.columns.length)
    throw new HistoryError(
      'INVALID_EVENT',
      'Replication tuple must contain every recorded column.',
    );
  return table.columns.map((column) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, column.name);
    if (!descriptor || !('value' in descriptor))
      throw new HistoryError(
        'INVALID_EVENT',
        'Replication tuple has a missing column or accessor.',
      );
    return descriptor.value as unknown;
  });
}

function complete(
  table: TableSchema,
  raw: readonly unknown[],
  previous?: Row,
): Row {
  return decodeRow(
    table,
    table.columns.map((column, index): Value => {
      const value = raw[index];
      if (value === undefined) {
        const retained = previous?.[index];
        if (!retained || retained.kind === 'unavailable')
          throw new HistoryError(
            'INVALID_HISTORY',
            'Unchanged TOAST requires an available recorded prior value.',
          );
        return retained;
      }
      if (value === null) return { kind: 'null' };
      if (typeof value !== 'string')
        throw new HistoryError(
          'INVALID_VALUE',
          'Replication requires text-format values.',
        );
      return { kind: 'scalar', type: column.type, value };
    }),
  );
}

/**
 * readRow reads recorded transaction-local state, including earlier changes in
 * the same transaction. It must never query the live source. No state is mutated.
 */
export function postgresChange(
  recording: RecordingSchema,
  message: Change,
  readRow: (tableId: string, key: string) => Row | undefined,
): RowEvent {
  const table = postgresRelation(recording, message.relation);
  if (message.tag === 'insert')
    return Object.freeze({
      kind: 'insert',
      tableId: table.id,
      after: complete(table, tuple(table, message.new)),
    });
  if (!message.old || message.key)
    throw new HistoryError(
      'INVALID_EVENT',
      'REPLICA IDENTITY FULL before-image is required.',
    );
  const old = tuple(table, message.old);
  // Only key components participate in rowKey; placeholders never leave this lookup.
  const identity = table.columns.map((column, index): Value => {
    if (!table.primaryKey.includes(column.name)) return { kind: 'null' };
    const raw = old[index];
    if (typeof raw !== 'string')
      throw new HistoryError(
        'INVALID_HISTORY',
        'Before-image requires available primary-key values.',
      );
    return scalarValue(column.type, raw);
  });
  const previous = readRow(table.id, rowKey(recording, table, identity));
  if (!previous)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Replication change refers to a missing recorded row.',
    );
  const before = complete(table, old, previous);
  if (JSON.stringify(before) !== JSON.stringify(previous))
    throw new HistoryError(
      'INVALID_HISTORY',
      'Replication before-image differs from recorded state.',
    );
  return message.tag === 'delete'
    ? Object.freeze({ kind: 'delete', tableId: table.id, before })
    : Object.freeze({
        kind: 'update',
        tableId: table.id,
        before,
        after: complete(table, tuple(table, message.new), before),
      });
}
