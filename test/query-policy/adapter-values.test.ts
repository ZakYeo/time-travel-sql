import { expect, it } from 'vitest';
import { createHistoricalQueryEngine } from '@time-travel-sql/query-pglite';
import {
  decodeQueryRequest,
  decodeRecordingSchema,
  scalarValue,
} from '@time-travel-sql/sdk';
import type { ScalarType } from '@time-travel-sql/sdk';
import { pair, recording } from '../../test-support/investigation-fixture.js';
import { Sql } from '@time-travel-sql/sql-postgres';

it('materializes all capture scalars and modifiers with bound exact text and quoted identifiers', async () => {
  const fields: readonly [ScalarType, string, number, string][] = [
    ['int8', '9007199254740993', -1, '9007199254740993'],
    ['bool', 'true', -1, 't'],
    ['int2', '-32768', -1, '-32768'],
    ['int4', '-2147483648', -1, '-2147483648'],
    [
      'numeric',
      '1.234567890123456789',
      (30 << 16) + 18 + 4,
      '1.234567890123456789',
    ],
    ['numeric', '1200', (4 << 16) + 2046 + 4, '1200'],
    [
      'text',
      "'; DROP SCHEMA public CASCADE; -- 雪",
      -1,
      "'; DROP SCHEMA public CASCADE; -- 雪",
    ],
    ['varchar', 'a雪', 6, 'a雪'],
    [
      'uuid',
      '12345678-1234-1234-1234-123456789abc',
      -1,
      '12345678-1234-1234-1234-123456789abc',
    ],
    ['date', '2026-01-02', -1, '2026-01-02'],
    [
      'timestamp',
      '2026-01-02T12:13:14.123456',
      6,
      '2026-01-02 12:13:14.123456',
    ],
    [
      'timestamptz',
      '2026-01-02T12:13:14.123Z',
      3,
      '2026-01-02 12:13:14.123+00',
    ],
    ['json', '{"n":9007199254740993}', -1, '{"n":9007199254740993}'],
    ['jsonb', '{"n":9007199254740993}', -1, '{"n": 9007199254740993}'],
    ['bytea', '\\x00ff5c', -1, '\\x00ff5c'],
  ];
  const namespace = 'odd"schema';
  const name = "table';--";
  const columns = fields.map(([type, , typeModifier], index) => ({
    name: `column"${index}`,
    type,
    nullable: false,
    typeModifier,
  }));
  const schema = decodeRecordingSchema({
    ...recording,
    schema: {
      version: 1,
      id: 'exact',
      tables: [
        {
          id: 'data',
          namespace,
          name,
          columns,
          primaryKey: ['column"3', 'column"0'],
        },
      ],
    },
  });
  const view = pair(
    [],
    [
      {
        tableId: 'data',
        row: fields.map(([type, value]) => scalarValue(type, value)),
      },
    ],
    schema,
  ).to;
  const engine = createHistoricalQueryEngine();
  try {
    const sql =
      Sql.query`SELECT ${Sql.join(columns.map((column) => Sql.identifier(column.name)))} FROM ${Sql.identifier(namespace, name)} GROUP BY ${Sql.identifier('column"3')}, ${Sql.identifier('column"0')}`
        .text;
    const result = await engine.query(view, decodeQueryRequest({ sql }));
    expect(result.rows).toEqual([fields.map(([, , , expected]) => expected)]);
    expect(result.columns.map((column) => column.name)).toEqual(
      columns.map((column) => column.name),
    );
  } finally {
    await engine.close();
  }
});
