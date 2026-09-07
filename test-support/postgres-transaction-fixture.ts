import type { Pgoutput } from 'pg-logical-replication';
import {
  HistoryState,
  decodeRecordingSchema,
  scalarValue,
} from '@time-travel-sql/sdk';
import { PgoutputFrame } from '@time-travel-sql/source-postgres';

export const recording = decodeRecordingSchema({
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
          { name: 'id', type: 'int4', nullable: false, typeModifier: -1 },
          { name: 'body', type: 'text', nullable: true, typeModifier: -1 },
        ],
        primaryKey: ['id'],
      },
    ],
  },
});
export const baseline = () => HistoryState.fromSnapshot(recording, '0', []);
export const relation: Pgoutput.MessageRelation = {
  tag: 'relation',
  relationOid: 42,
  schema: 'public',
  name: 'items',
  replicaIdentity: 'full',
  keyColumns: ['id', 'body'],
  columns: [
    {
      name: 'id',
      flags: 1,
      typeOid: 23,
      typeMod: -1,
      typeSchema: null,
      typeName: null,
      parser: (raw: unknown) => raw,
    },
    {
      name: 'body',
      flags: 1,
      typeOid: 25,
      typeMod: -1,
      typeSchema: null,
      typeName: null,
      parser: (raw: unknown) => raw,
    },
  ],
};
export const frame = (message: Pgoutput.Message, bytes = 1) =>
  new PgoutputFrame({ kind: 'message', message, bytes });
export const begin = (lsn = '0/10', time = 946684800000001n) =>
  frame({ tag: 'begin', commitLsn: lsn, commitTime: time, xid: 4294967295 });
export const commit = (lsn = '0/10', end = '0/11', time = 946684800000001n) =>
  frame({
    tag: 'commit',
    flags: 0,
    commitLsn: lsn,
    commitEndLsn: end,
    commitTime: time,
  });
export const insert = (id = '1', body: string | null = 'retained') =>
  frame({ tag: 'insert', relation, new: { id, body } });
export const expectedRow = (id = '1') => [
  scalarValue('int4', id),
  scalarValue('text', 'retained'),
];
