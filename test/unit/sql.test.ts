import { expect, it } from 'vitest';
import { Sql } from '@time-travel-sql/sql-postgres';

it('composes qualified identifiers and values without interpreting their syntax', () => {
  const query = Sql.query`SELECT ${Sql.join([Sql.identifier('a"b'), Sql.literal("x\\'; DROP TABLE sentinel; --")])} FROM ${Sql.identifier('odd.schema', 'table')}`;
  expect(query.text).toBe(
    'SELECT "a""b", E\'x\\\\\'\'; DROP TABLE sentinel; --\' FROM "odd.schema"."table"',
  );
  expect(Object.isFrozen(query)).toBe(true);
});

it('rejects bare interpolation rather than implicitly trusting strings', () => {
  expect(() => {
    // @ts-expect-error Bare strings cannot be SQL fragments.
    return Sql.query`SELECT ${'unsafe'}`;
  }).toThrow('SQL fragment');
});

it('rejects malformed values and empty dynamic lists', () => {
  expect(() => Sql.literal('\0')).toThrow();
  expect(() => Sql.literal('\ud800')).toThrow();
  expect(() => Sql.identifier('é'.repeat(32))).toThrow();
  expect(() => Sql.identifier()).toThrow();
  expect(() => Sql.integer(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  expect(() => Sql.join([])).toThrow();
});

it('constructs bounded parameter placeholders for driver-bound values', () => {
  expect(
    Sql.query`SELECT ${Sql.parameter(1)}, ${Sql.parameter(65535)}`.text,
  ).toBe('SELECT $1, $65535');
  for (const index of [0, -1, 1.5, 65536, NaN])
    expect(() => Sql.parameter(index)).toThrow();
});
