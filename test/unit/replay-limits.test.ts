import { expect, it } from 'vitest';
import {
  HistoryState,
  decodeReplayLimits,
  decodeTransaction,
  scalarValue,
} from '@time-travel-sql/sdk';
import {
  metadata,
  row,
  transaction,
} from '../../test-support/storage-fixture.js';

it('bounds baseline rows and retained UTF-8 bytes before returning a state', () => {
  expect(() =>
    HistoryState.fromSnapshot(metadata.recording, '0', [row('1'), row('2')], {
      maxRows: 1,
      maxBytes: 10000,
    }),
  ).toThrow('budget');
  const one = HistoryState.fromSnapshot(metadata.recording, '0', [row('1')]);
  expect(one.rowCount).toBe(1);
  expect(() =>
    HistoryState.fromSnapshot(metadata.recording, '0', [row('1')], {
      maxRows: 1,
      maxBytes: one.retainedBytes - 1,
    }),
  ).toThrow('budget');
  expect(
    HistoryState.fromSnapshot(metadata.recording, '0', [row('1')], {
      maxRows: 1,
      maxBytes: one.retainedBytes,
    }).retainedBytes,
  ).toBe(one.retainedBytes);
});

it('preserves the predecessor when a transaction exceeds its state budget', () => {
  const state = HistoryState.fromSnapshot(metadata.recording, '0', [row('1')], {
    maxRows: 1,
    maxBytes: 10000,
  });
  expect(() => state.apply(transaction('10', '0', '2'))).toThrow('budget');
  expect(state.position).toBe('0');
  expect(state.rows('orders')).toEqual([row('1').row]);
  const update = decodeTransaction(metadata.recording, {
    ...transaction('10', '0', '2'),
    events: [
      {
        kind: 'update',
        tableId: 'orders',
        before: row('1').row,
        after: row('2').row,
      },
    ],
  });
  const next = state.apply(update);
  expect(next.rowCount).toBe(1);
  expect(next.retainedBytes).toBe(state.retainedBytes);
  const deletion = decodeTransaction(metadata.recording, {
    ...transaction('20', '10', '2'),
    events: [{ kind: 'delete', tableId: 'orders', before: row('2').row }],
  });
  expect(next.apply(deletion).retainedBytes).toBe(0);
});

it('counts multibyte row data and keys without treating UTF-16 length as bytes', () => {
  const recording = {
    ...metadata.recording,
    schema: {
      ...metadata.recording.schema,
      tables: [
        {
          id: 'texts',
          namespace: 'public',
          name: 'texts',
          columns: [
            { name: 'id', type: 'text', nullable: false, typeModifier: -1 },
          ],
          primaryKey: ['id'],
        },
      ],
    },
  };
  const ascii = HistoryState.fromSnapshot(recording, '0', [
    { tableId: 'texts', row: [scalarValue('text', 'x')] },
  ]);
  const unicode = HistoryState.fromSnapshot(recording, '0', [
    { tableId: 'texts', row: [scalarValue('text', '漢')] },
  ]);
  expect(unicode.retainedBytes - ascii.retainedBytes).toBe(4);
  expect(() =>
    decodeReplayLimits({ maxRows: Infinity, maxBytes: 1 }),
  ).toThrow();
});
