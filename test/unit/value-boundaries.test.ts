import { expect, it } from 'vitest';
import {
  decodeSchema,
  decodeRow,
  scalarValue,
  decodeTransaction,
  decodeRecordingSchema,
} from '../../packages/sdk/src/index.js';

const schemaInput = (type: string, typeModifier = -1) => ({
  version: 1,
  id: 'schema',
  tables: [
    {
      id: 'table',
      namespace: 'public',
      name: 'selected',
      columns: [{ name: 'id', type, typeModifier, nullable: false }],
      primaryKey: ['id'],
    },
  ],
});
const table = (type: string, typeModifier = -1) => {
  const result = decodeSchema(schemaInput(type, typeModifier)).tables[0];
  if (!result) throw new Error('Missing test table.');
  return result;
};

it.each(['"\\u0000"', '"\\ud800"', '{"\\udfff":1}', '1e200000', '1e-16384'])(
  'rejects invalid PostgreSQL JSONB %s while retaining JSON syntax',
  (input) => {
    expect(() => scalarValue('jsonb', input)).toThrow();
    expect(scalarValue('json', input).value).toBe(input);
  },
);

it('measures encoded row limits in UTF-8 including array framing', () => {
  const one = table('text');
  const overhead = Buffer.byteLength(JSON.stringify([scalarValue('text', '')]));
  expect(() =>
    decodeRow(one, [scalarValue('text', 'x'.repeat(1048576 - overhead))]),
  ).not.toThrow();
  expect(() =>
    decodeRow(one, [scalarValue('text', 'x'.repeat(1048577 - overhead))]),
  ).toThrow();
  const two = {
    ...one,
    columns: [
      ...one.columns,
      {
        name: 'second',
        type: 'text' as const,
        nullable: false,
        typeModifier: -1,
      },
    ],
  };
  expect(() =>
    decodeRow(two, [
      scalarValue('text', '界'.repeat(200000)),
      scalarValue('text', '界'.repeat(200000)),
    ]),
  ).toThrow();
});

it('measures transaction limits in UTF-8 and rejects sparse/accessor arrays', () => {
  const recording = decodeRecordingSchema({
    sourceId: 'source',
    epochId: 'epoch',
    schema: schemaInput('text'),
  });
  const events = Array.from({ length: 18 }, () => ({
    kind: 'insert',
    tableId: 'table',
    after: [scalarValue('text', '界'.repeat(320000))],
  }));
  expect(() =>
    decodeTransaction(recording, {
      id: 'tx',
      sourceId: 'source',
      epochId: 'epoch',
      schemaId: 'schema',
      previousPosition: '0',
      position: '1',
      events,
    }),
  ).toThrow();
  expect(() => decodeRow(table('text'), Array(1))).toThrow();
  const values = [scalarValue('text', 'x')];
  Object.defineProperty(values, '0', {
    get: () => {
      throw new Error('Accessor must not execute.');
    },
  });
  expect(() => decodeRow(table('text'), values)).toThrow('Array accessors');
});

it('validates varchar character limits, timestamp precision and numeric rounding/overflow', () => {
  expect(() =>
    decodeRow(table('varchar', 5), [scalarValue('varchar', '😀')]),
  ).not.toThrow();
  expect(() =>
    decodeRow(table('varchar', 5), [scalarValue('varchar', 'ab')]),
  ).toThrow();
  expect(() => table('timestamp', 7)).toThrow();
  expect(() => table('int4', 2)).toThrow();
  expect(() =>
    decodeRow(table('timestamp', 3), [
      scalarValue('timestamp', '2026-01-01 00:00:00.123400'),
    ]),
  ).toThrow();
  const numeric42 = (4 << 16) + 2 + 4;
  expect(() =>
    decodeRow(table('numeric', numeric42), [scalarValue('numeric', '99.99')]),
  ).not.toThrow();
  expect(() =>
    decodeRow(table('numeric', numeric42), [scalarValue('numeric', '100.00')]),
  ).toThrow();
  expect(() =>
    decodeRow(table('numeric', numeric42), [scalarValue('numeric', '1.001')]),
  ).toThrow();
  const numericNegative = (4 << 16) + 2047 + 4;
  expect(() =>
    decodeRow(table('numeric', numericNegative), [
      scalarValue('numeric', '120'),
    ]),
  ).not.toThrow();
  expect(() =>
    decodeRow(table('numeric', numericNegative), [
      scalarValue('numeric', '125'),
    ]),
  ).toThrow();
});
