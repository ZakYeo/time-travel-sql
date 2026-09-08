import { expect, it } from 'vitest';
import {
  QueryResultBuffer,
  decodeQueryRequest,
  decodeQueryLimits,
} from '@time-travel-sql/sdk';

const columns = [{ name: 'value', typeOid: 25 }];

it('preserves duplicate result names, exact text and SQL NULL by ordinal', () => {
  const fields = [
    { name: 'same', typeOid: 1700 },
    { name: 'same', typeOid: 114 },
    { name: 'when', typeOid: 1114 },
    { name: '', typeOid: 25 },
  ];
  const row = [
    '1.234567890123456789',
    '{"n":9007199254740993}',
    '2026-01-01 12:13:14.123456',
    null,
  ];
  const buffer = new QueryResultBuffer(fields);
  buffer.append(row);
  row[0] = 'changed';
  const first = fields[0];
  if (!first) throw new Error('Missing test column');
  first.name = 'changed';
  const result = buffer.finish();
  expect(result.columns[0]?.name).toBe('same');
  expect(result.rows[0]?.[0]).toBe('1.234567890123456789');
  expect(result.rows[0]?.slice(1)).toEqual(row.slice(1));
  expect(Object.isFrozen(result.rows[0])).toBe(true);
  expect(Object.isFrozen(result.columns[0])).toBe(true);
  expect(() => buffer.append(row)).toThrow();
  expect(() => buffer.finish()).toThrow();
});

it('accounts for the exact compact JSON envelope including escaping and UTF-8', () => {
  const rows = [['é\n"\\'], [null]];
  const expected = { columns, rows };
  const bytes = Buffer.byteLength(JSON.stringify(expected));
  const buffer = new QueryResultBuffer(columns, { maxResultBytes: bytes });
  for (const row of rows) buffer.append(row);
  expect(buffer.finish()).toEqual(expected);
  const short = new QueryResultBuffer(columns, { maxResultBytes: bytes - 1 });
  short.append(rows[0]);
  expect(() => short.append(rows[1])).toThrow(
    expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
  );
  expect(() => short.finish()).toThrow();
  expect(() => new QueryResultBuffer(columns, { maxResultBytes: 1 })).toThrow();
});

it('fails closed on row, column and cell limits and malformed result shapes', () => {
  const rowLimit = new QueryResultBuffer(columns, { maxRows: 1 });
  rowLimit.append(['first']);
  expect(() => rowLimit.append(['extra'])).toThrow(
    expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
  );
  expect(() => rowLimit.finish()).toThrow();
  expect(
    () => new QueryResultBuffer([...columns, ...columns], { maxColumns: 1 }),
  ).toThrow();
  const utf8 = new QueryResultBuffer(columns, { maxCellBytes: 3 });
  expect(() => utf8.append(['😀'])).toThrow();
  expect(() => utf8.finish()).toThrow();
  for (const row of [[123], [undefined], [], ['x', 'y'], ['\ud800'], ['\0']]) {
    const buffer = new QueryResultBuffer(columns);
    expect(() => buffer.append(row)).toThrow();
    expect(() => buffer.finish()).toThrow();
  }
  expect(() => new QueryResultBuffer([{ name: 'x', typeOid: 0 }])).toThrow();
  expect(
    () => new QueryResultBuffer([{ name: 'x', typeOid: 4294967296 }]),
  ).toThrow();
  const empty = new QueryResultBuffer([]);
  empty.append([]);
  expect(empty.finish()).toEqual({ columns: [], rows: [[]] });
});

it('validates query bounds without pretending to classify SQL syntax', () => {
  expect(
    decodeQueryRequest({ sql: 'WITH q AS (SELECT 1) SELECT * FROM q' }).limits
      .maxRows,
  ).toBe(1000);
  expect(decodeQueryRequest({ sql: 'DELETE FROM orders' }).sql).toBe(
    'DELETE FROM orders',
  );
  for (const sql of ['', ' \n ', '\0', 'x'.repeat(65537), 'é'.repeat(32769)])
    expect(() => decodeQueryRequest({ sql })).toThrow();
  for (const limits of [
    null,
    { timeoutMs: 0 },
    { maxRows: Infinity },
    { maxRows: 1.5 },
    { maxRows: 10001 },
    { maxBytes: 5 },
  ])
    expect(() => decodeQueryLimits(limits)).toThrow();
  const getter = Object.defineProperty({}, 'maxRows', {
    get() {
      throw new Error('must not invoke');
    },
  });
  expect(() => decodeQueryLimits(getter)).toThrow(
    'Accessor properties are not data.',
  );
});

it('rejects a logical GiB row promptly within a small output budget', () => {
  const wide = Array.from({ length: 1024 }, () => ({
    name: 'value',
    typeOid: 25,
  }));
  const buffer = new QueryResultBuffer(wide, {
    maxColumns: 1024,
    maxResultBytes: 65536,
  });
  const cells = Array.from({ length: 1024 }, () => 'x'.repeat(1048576));
  expect(() => buffer.append(cells)).toThrow(
    expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
  );
  expect(() => buffer.finish()).toThrow();
});
