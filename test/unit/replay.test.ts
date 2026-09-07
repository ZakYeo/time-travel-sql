import { expect, it } from 'vitest';
import {
  HistoryState,
  scalarValue,
  decodeSchema,
} from '../../packages/sdk/src/index.js';

const schema = {
  version: 1,
  id: 'schema-1',
  tables: [
    {
      id: 'orders',
      namespace: 'shop',
      name: 'orders',
      columns: [
        { name: 'tenant', type: 'text', nullable: false, typeModifier: -1 },
        { name: 'id', type: 'numeric', nullable: false, typeModifier: -1 },
        { name: 'total', type: 'int4', nullable: false, typeModifier: -1 },
      ],
      primaryKey: ['tenant', 'id'],
    },
  ],
};
const recording = { sourceId: 'source-1', epochId: 'epoch-1', schema };
const row = (id: string, total: number) => [
  scalarValue('text', 'tenant'),
  scalarValue('numeric', id),
  scalarValue('int4', String(total)),
];
const initial = () =>
  HistoryState.fromSnapshot(recording, '10', [
    { tableId: 'orders', row: row('1.00', 10) },
  ]);
const commit = (
  events: unknown[],
  position = '20',
  previousPosition = '10',
) => ({
  id: 'tx-' + position,
  sourceId: 'source-1',
  epochId: 'epoch-1',
  schemaId: 'schema-1',
  position,
  previousPosition,
  events,
});

it('replays repeated updates and key changes atomically while preserving the predecessor', () => {
  const before = initial();
  const transaction = commit([
    {
      kind: 'update',
      tableId: 'orders',
      before: row('1.00', 10),
      after: row('1.00', 11),
    },
    {
      kind: 'update',
      tableId: 'orders',
      before: row('1.00', 11),
      after: row('2', 12),
    },
  ]);
  const after = before.apply(transaction);
  expect(before.rows('orders')).toEqual([row('1.00', 10)]);
  expect(after.rows('orders')).toEqual([row('2', 12)]);
  expect(after.position).toBe('20');
  expect(after.apply(transaction)).toBe(after);
});

it('publishes none of a transaction when a later event is invalid', () => {
  const state = initial();
  expect(() =>
    state.apply(
      commit([
        { kind: 'insert', tableId: 'orders', after: row('2', 20) },
        { kind: 'delete', tableId: 'orders', before: row('9', 99) },
      ]),
    ),
  ).toThrow();
  expect(state.rows('orders')).toEqual([row('1.00', 10)]);
  expect(state.position).toBe('10');
});

it('rejects SQL-equivalent duplicate keys, stale before images and missing predecessors', () => {
  const state = initial();
  expect(() =>
    state.apply(
      commit([{ kind: 'insert', tableId: 'orders', after: row('1', 99) }]),
    ),
  ).toThrow();
  expect(() =>
    state.apply(
      commit([
        {
          kind: 'update',
          tableId: 'orders',
          before: row('1.00', 99),
          after: row('1', 2),
        },
      ]),
    ),
  ).toThrow();
  expect(() => state.apply(commit([], '20', '9'))).toThrow();
  expect(() => state.apply({ ...commit([]), schemaId: 'other' })).toThrow();
  expect(() => state.apply({ ...commit([]), sourceId: 'other' })).toThrow();
  expect(() => state.apply({ ...commit([]), epochId: 'other' })).toThrow();
  expect(() =>
    HistoryState.fromSnapshot(recording, '10', [
      { tableId: 'orders', row: row('1', 1) },
      { tableId: 'orders', row: row('1.0', 2) },
    ]),
  ).toThrow();
});

it('rejects malformed schemas, row shapes and divergent redelivery', () => {
  expect(() =>
    decodeSchema({ ...schema, tables: [schema.tables[0], schema.tables[0]] }),
  ).toThrow();
  expect(() =>
    HistoryState.fromSnapshot(recording, '0', [
      { tableId: 'orders', row: [scalarValue('text', 'missing')] },
    ]),
  ).toThrow();
  const state = initial().apply(commit([]));
  expect(() =>
    state.apply(
      commit([{ kind: 'insert', tableId: 'orders', after: row('3', 3) }]),
    ),
  ).toThrow();
});

it('matches an independent generated history oracle at every committed boundary', () => {
  let state = HistoryState.fromSnapshot(recording, '0', []);
  const model = new Map<number, number>();
  let seed = 41;
  for (let step = 1; step <= 300; step++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const id = seed % 30;
    const prior = model.get(id);
    const value = seed % 1000;
    const event =
      prior === undefined
        ? { kind: 'insert', tableId: 'orders', after: row(String(id), value) }
        : step % 3 === 0
          ? {
              kind: 'delete',
              tableId: 'orders',
              before: row(String(id), prior),
            }
          : {
              kind: 'update',
              tableId: 'orders',
              before: row(String(id), prior),
              after: row(String(id), value),
            };
    if (prior !== undefined && step % 3 === 0) model.delete(id);
    else model.set(id, value);
    state = state.apply(commit([event], String(step), String(step - 1)));
    expect(
      state
        .rows('orders')
        .map((record) => JSON.stringify(record))
        .sort(),
    ).toEqual(
      [...model]
        .map(([key, total]) => JSON.stringify(row(String(key), total)))
        .sort(),
    );
  }
});
