import { expect, it } from 'vitest';
import {
  postgresSchema,
  postgresRow,
  postgresTableId,
} from '@time-travel-sql/source-postgres';
import type { PostgresTable } from '@time-travel-sql/source-postgres';

const table: PostgresTable = {
  oid: '4294967295',
  namespace: 'odd"schema',
  name: 'orders',
  columns: [
    {
      name: 'amount',
      typeOid: 1700,
      typeModifier: -1,
      nullable: true,
      keyOrder: null,
    },
    { name: 'id', typeOid: 20, typeModifier: -1, nullable: false, keyOrder: 1 },
    {
      name: 'tenant',
      typeOid: 25,
      typeModifier: -1,
      nullable: false,
      keyOrder: 0,
    },
  ],
};

it('maps catalog order and composite index order independently without losing values', () => {
  const schema = postgresSchema('revision', [table]);
  const selected = schema.tables[0];
  if (!selected) throw new Error('Missing table');
  expect(selected.id).toBe('pg_4294967295');
  expect(selected.primaryKey).toEqual(['tenant', 'id']);
  expect(
    postgresRow(selected, [
      '12345678901234567890.123456',
      '9223372036854775807',
      '',
    ]),
  ).toEqual([
    { kind: 'scalar', type: 'numeric', value: '12345678901234567890.123456' },
    { kind: 'scalar', type: 'int8', value: '9223372036854775807' },
    { kind: 'scalar', type: 'text', value: '' },
  ]);
  expect(postgresRow(selected, [null, '1', 'tenant'])[0]).toEqual({
    kind: 'null',
  });
  expect(() => postgresRow(selected, ['1'])).toThrow();
  expect(() => postgresRow(selected, [null, null, 'tenant'])).toThrow();
  expect(() => postgresRow(selected, new Array<string>(3))).toThrow();
});

it('rejects unsupported types, invalid key ordinals and noncanonical relation identities', () => {
  for (const oid of ['0', '-1', '01', '4294967296', '1.0'])
    expect(() => postgresTableId(oid)).toThrow();
  for (const columns of [
    table.columns.map((column) => ({ ...column, typeOid: 99999 })),
    table.columns.map((column) => ({ ...column, keyOrder: 0 })),
    table.columns.map((column) => ({ ...column, keyOrder: 2 })),
  ])
    expect(() => postgresSchema('revision', [{ ...table, columns }])).toThrow();
  expect(() => postgresSchema('revision', [table, table])).toThrow();
});
