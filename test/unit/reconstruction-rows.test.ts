import { expect, it } from 'vitest';
import {
  decodeReconstructionInfo,
  decodeRecordingInfo,
  HistoryState,
  reconstructionRows,
} from '@time-travel-sql/sdk';
import type {
  ReconstructionSession,
  Page,
  Row,
  SnapshotRow,
} from '@time-travel-sql/sdk';
import { metadata, row } from '../../test-support/storage-fixture.js';

const state = HistoryState.fromSnapshot(metadata.recording, '0', [
  row('1'),
  row('2'),
]);
const info = decodeReconstructionInfo({
  recording: decodeRecordingInfo({
    ...metadata,
    status: 'recording',
    baselinePosition: '0',
    headPosition: '0',
    baselineRowCount: 2,
    baselineChecksum: 'a'.repeat(64),
    transactionCount: 0,
  }),
  selection: { kind: 'baseline' },
  position: '0',
  rowCount: state.rowCount,
  retainedBytes: state.retainedBytes,
  limits: state.limits,
});

function session(pages: readonly Page<Row>[]): ReconstructionSession {
  let index = 0;
  return {
    info,
    async rows() {
      const page = pages[index++];
      if (!page) throw new Error('Unexpected extra page');
      return page;
    },
    async close() {
      throw new Error('Reader must not close caller-owned session');
    },
  };
}

async function consume(reader: ReconstructionSession): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  for await (const value of reconstructionRows(reader)) rows.push(value);
  return rows;
}

it('streams validated provider pages without taking ownership of the session', async () => {
  const reader = session([
    { items: [row('1').row], nextCursor: 'one' },
    { items: [row('2').row], nextCursor: null },
  ]);
  expect(await consume(reader)).toEqual([row('1'), row('2')]);
});

it.each([
  [[{ items: [row('1').row], nextCursor: null }], 'state size'],
  [
    [
      { items: [row('1').row], nextCursor: 'one' },
      { items: [row('1').row], nextCursor: null },
    ],
    'duplicated',
  ],
  [[{ items: [], nextCursor: 'one' }], 'progress'],
  [
    [
      { items: [row('1').row], nextCursor: 'one' },
      { items: [row('2').row], nextCursor: 'one' },
    ],
    'progress',
  ],
] satisfies readonly [readonly Page<Row>[], string][])(
  'rejects incomplete or non-progressing provider pages',
  async (pages, message) => {
    await expect(consume(session(pages))).rejects.toThrow(message);
  },
);

it('rejects provider metadata that contradicts selection or state bounds', () => {
  expect(() => decodeReconstructionInfo({ ...info, position: '1' })).toThrow();
  expect(() => decodeReconstructionInfo({ ...info, rowCount: 0 })).toThrow();
  expect(() =>
    decodeReconstructionInfo({
      ...info,
      retainedBytes: info.limits.maxBytes + 1,
    }),
  ).toThrow();
});

it('restarts cursor and row ordering for each table in schema order', async () => {
  const orders = metadata.recording.schema.tables[0];
  if (!orders) throw new Error('Missing fixture table');
  const recording = {
    ...metadata.recording,
    schema: {
      ...metadata.recording.schema,
      tables: [orders, { ...orders, id: 'customers', name: 'customers' }],
    },
  };
  const expected = [row('1'), row('2'), { ...row('1'), tableId: 'customers' }];
  const multiple = HistoryState.fromSnapshot(recording, '0', expected);
  const calls: unknown[] = [];
  const reader: ReconstructionSession = {
    info: decodeReconstructionInfo({
      ...info,
      recording: { ...info.recording, recording, baselineRowCount: 3 },
      rowCount: multiple.rowCount,
      retainedBytes: multiple.retainedBytes,
    }),
    async rows(table, page) {
      calls.push([table, page.cursor]);
      return table === 'orders' && page.cursor === null
        ? { items: [row('1').row], nextCursor: 'next' }
        : {
            items: [row(table === 'orders' ? '2' : '1').row],
            nextCursor: null,
          };
    },
    async close() {},
  };
  expect(await consume(reader)).toEqual(expected);
  expect(calls).toEqual([
    ['orders', null],
    ['orders', 'next'],
    ['customers', null],
  ]);
});
