import { setImmediate } from 'node:timers/promises';
import {
  HistoryState,
  decodeRecordingSchema,
  decodeRecordingInfo,
  decodeReconstructionInfo,
  scalarValue,
} from '@time-travel-sql/sdk';
import type {
  SnapshotRow,
  Value,
  ReconstructionView,
} from '@time-travel-sql/sdk';
import { metadata } from './storage-fixture.js';

export const recording = decodeRecordingSchema({
  ...metadata.recording,
  schema: {
    version: 1,
    id: 'schema',
    tables: ['orders', 'customers'].map((id) => ({
      id,
      namespace: 'public',
      name: id,
      columns: [
        { name: 'id', type: 'text', nullable: false, typeModifier: -1 },
        { name: 'amount', type: 'numeric', nullable: false, typeModifier: -1 },
        { name: 'note', type: 'text', nullable: true, typeModifier: -1 },
      ],
      primaryKey: ['id'],
    })),
  },
});
export function snapshot(
  id: string,
  amount = '1.00',
  note: Value = { kind: 'null' },
  tableId = 'orders',
): SnapshotRow {
  return {
    tableId,
    row: [scalarValue('text', id), scalarValue('numeric', amount), note],
  };
}
export function pair(
  before: readonly SnapshotRow[],
  after: readonly SnapshotRow[],
  schema = recording,
) {
  const info = decodeRecordingInfo({
    ...metadata,
    recording: schema,
    status: 'stopped',
    baselinePosition: '0',
    baselineRowCount: before.length,
    baselineChecksum: 'a'.repeat(64),
    headPosition: '20',
    transactionCount: 1,
  });
  function view(
    rows: readonly SnapshotRow[],
    position: string,
  ): ReconstructionView {
    const state = HistoryState.fromSnapshot(schema, position, rows);
    return {
      info: decodeReconstructionInfo({
        recording: info,
        selection:
          position === '0' ? { kind: 'baseline' } : { kind: 'after', position },
        position,
        rowCount: state.rowCount,
        retainedBytes: state.retainedBytes,
        limits: state.limits,
      }),
      rows: async (table, page) => {
        const values = state.rows(table);
        const start = Number(page.cursor ?? '0');
        const items = values.slice(start, start + page.limit);
        return {
          items,
          nextCursor:
            start + items.length < values.length
              ? String(start + items.length)
              : null,
        };
      },
    };
  }
  return {
    from: view(before, '0'),
    to: view(after, '20'),
    close: async () => {
      throw new Error('Borrowed pair must not be closed');
    },
  };
}
export function control(controller = new AbortController()) {
  return {
    signal: controller.signal,
    cooperate: async () => {
      await setImmediate();
    },
  };
}
