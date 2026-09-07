import { expect, it } from 'vitest';
import {
  decodeValue,
  scalarValue,
  valueIdentity,
} from '../../packages/sdk/src/index.js';

it('preserves exact scalar values through canonical JSON serialization', () => {
  for (const [type, raw] of [
    ['int8', '9223372036854775807'],
    ['numeric', '12345678901234567890.123456789'],
    ['timestamp', '2026-01-02 03:04:05.123456'],
    ['timestamptz', '2026-01-02 03:04:05.123456+00'],
    ['jsonb', '{"n":90071992547409931234567890,"nothing":null}'],
    ['bytea', '\\x00ff'],
  ] as const) {
    const value = scalarValue(type, raw);
    expect(decodeValue(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(Object.isFrozen(value)).toBe(true);
  }
});

it('distinguishes NULL, empty text, JSON null and unavailable data', () => {
  const values = [
    decodeValue({ kind: 'null' }),
    scalarValue('text', ''),
    scalarValue('json', 'null'),
    decodeValue({ kind: 'unavailable', reason: 'redacted' }),
  ];
  expect(new Set(values.map((value) => JSON.stringify(value))).size).toBe(4);
});

it('uses SQL-equivalent numeric, JSONB and temporal identities without precision loss', () => {
  expect(valueIdentity(scalarValue('numeric', '1.00'))).toBe(
    valueIdentity(scalarValue('numeric', '1')),
  );
  expect(valueIdentity(scalarValue('numeric', '-0.00'))).toBe(
    valueIdentity(scalarValue('numeric', '0')),
  );
  expect(valueIdentity(scalarValue('jsonb', '{"b":2,"a":1.00}'))).toBe(
    valueIdentity(scalarValue('jsonb', '{"a":1e0,"b":2}')),
  );
  expect(
    valueIdentity(scalarValue('jsonb', '{"n":9007199254740993}')),
  ).not.toBe(valueIdentity(scalarValue('jsonb', '{"n":9007199254740992}')));
  expect(scalarValue('timestamp', '2026-01-02 03:04:05.1')).toEqual(
    scalarValue('timestamp', '2026-01-02 03:04:05.100000'),
  );
});

it.each([
  ['int2', '32768'],
  ['int4', '-2147483649'],
  ['int8', '9223372036854775808'],
  ['numeric', 'NaN'],
  ['date', '2025-02-29'],
  ['timestamp', '2026-01-01 24:00:00'],
  ['timestamp', '2026-01-01 00:00:00.1234567'],
  ['timestamptz', '2026-01-01 00:00:00+01'],
  ['json', '{"n":}'],
  ['jsonb', '[1,]'],
  ['bytea', '\\x0'],
  ['uuid', 'bad'],
] as const)('rejects unsupported or malformed %s value', (type, raw) => {
  expect(() => scalarValue(type, raw)).toThrow();
});

it('rejects unknown tags, extra fields, excessive nesting and oversized text', () => {
  expect(() =>
    decodeValue({ kind: 'scalar', type: 'text', value: '', secret: 'extra' }),
  ).toThrow();
  expect(() => decodeValue({ kind: 'unchanged' })).toThrow();
  expect(() =>
    scalarValue('json', '['.repeat(65) + '0' + ']'.repeat(65)),
  ).toThrow();
  expect(() => scalarValue('text', 'x'.repeat(1048577))).toThrow();
});
