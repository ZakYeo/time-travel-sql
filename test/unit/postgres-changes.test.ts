import { expect, it } from 'vitest';
import type { Pgoutput } from 'pg-logical-replication';
import { decodeRecordingSchema } from '@time-travel-sql/sdk';
import {
  postgresChange,
  postgresRelation,
  postgresRow,
} from '@time-travel-sql/source-postgres';

const recording = decodeRecordingSchema({
  sourceId: 'source',
  epochId: 'epoch',
  schema: {
    version: 1,
    id: 'schema',
    tables: [
      {
        id: 'pg_42',
        namespace: 'public',
        name: 'items',
        columns: [
          { name: 'id', type: 'int8', nullable: false, typeModifier: -1 },
          { name: '__proto__', type: 'text', nullable: true, typeModifier: -1 },
        ],
        primaryKey: ['id'],
      },
    ],
  },
});
const relation: Pgoutput.MessageRelation = {
  tag: 'relation',
  relationOid: 42,
  schema: 'public',
  name: 'items',
  replicaIdentity: 'full',
  keyColumns: ['id', '__proto__'],
  columns: [
    {
      name: 'id',
      flags: 1,
      typeOid: 20,
      typeMod: -1,
      typeSchema: null,
      typeName: null,
      parser: (raw: unknown) => raw,
    },
    {
      name: '__proto__',
      flags: 1,
      typeOid: 25,
      typeMod: -1,
      typeSchema: null,
      typeName: null,
      parser: (raw: unknown) => raw,
    },
  ],
};
const table = postgresRelation(recording, relation);
const previous = postgresRow(table, ['9007199254740993', 'retained']);
const old = { id: '9007199254740993', ['__proto__']: undefined };
const update: Pgoutput.MessageUpdate = {
  tag: 'update',
  relation,
  key: null,
  old,
  new: { id: '9007199254740994', ['__proto__']: undefined },
};

it('resolves unchanged TOAST from recorded prior values and preserves key changes', () => {
  const lookups: unknown[] = [];
  const event = postgresChange(recording, update, (table, key) => {
    lookups.push([table, key]);
    return previous;
  });
  expect(event).toEqual({
    kind: 'update',
    tableId: 'pg_42',
    before: previous,
    after: postgresRow(table, ['9007199254740994', 'retained']),
  });
  expect(lookups).toHaveLength(1);
  expect(String(lookups[0])).toContain('9007199254740993');
  expect(
    postgresChange(
      recording,
      { tag: 'delete', relation, key: null, old },
      () => previous,
    ),
  ).toEqual({ kind: 'delete', tableId: 'pg_42', before: previous });
});

it('keeps explicit NULL distinct and rejects missing, stale or incomplete history', () => {
  expect(
    postgresChange(
      recording,
      { ...update, new: { id: old.id, ['__proto__']: null } },
      () => previous,
    ),
  ).toMatchObject({ after: [{ kind: 'scalar' }, { kind: 'null' }] });
  for (const message of [
    { ...update, old: null },
    { ...update, key: { id: old.id } },
    { ...update, old: { id: old.id, ['__proto__']: 'stale' } },
    { ...update, old: { id: undefined, ['__proto__']: 'retained' } },
    { ...update, new: { id: old.id } },
    { ...update, new: { id: old.id, ['__proto__']: Buffer.from('binary') } },
  ])
    expect(() => postgresChange(recording, message, () => previous)).toThrow();
  expect(() => postgresChange(recording, update, () => undefined)).toThrow();
  expect(() =>
    postgresChange(
      recording,
      { tag: 'insert', relation, new: old },
      () => previous,
    ),
  ).toThrow();
});

it('rejects relation drift on every change and refuses tuple accessors', () => {
  for (const changed of [
    { ...relation, relationOid: 43 },
    { ...relation, name: 'renamed' },
    { ...relation, replicaIdentity: 'default' as const },
    { ...relation, columns: relation.columns.slice(1) },
    {
      ...relation,
      columns: relation.columns.map((column) => ({ ...column, typeMod: 7 })),
    },
  ])
    expect(() =>
      postgresChange(
        recording,
        { ...update, relation: changed },
        () => previous,
      ),
    ).toThrow();
  let read = false;
  const input = {
    id: old.id,
    get ['__proto__']() {
      read = true;
      return 'bad';
    },
  };
  expect(() =>
    postgresChange(recording, { ...update, new: input }, () => previous),
  ).toThrow();
  expect(read).toBe(false);
});
