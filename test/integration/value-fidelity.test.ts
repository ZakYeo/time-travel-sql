import pg from 'pg';
import { expect, it } from 'vitest';
import { scalarValue, valueIdentity } from '@time-travel-sql/sdk';
import { withPostgres } from '../../test-support/postgres.js';

it('agrees with independent PostgreSQL observations for every supported scalar type', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      await client.query(
        "SET timezone='UTC'; SET datestyle='ISO,YMD'; SET bytea_output='hex'",
      );
      const cases = [
        ['bool', 'boolean', 'true'],
        ['int2', 'smallint', '-32768'],
        ['int4', 'integer', '2147483647'],
        ['int8', 'bigint', '9223372036854775807'],
        ['numeric', 'numeric', '12345678901234567890.123456789'],
        ['text', 'text', 'control\ntext'],
        ['varchar', 'varchar(5)', '😀界'],
        ['uuid', 'uuid', 'AABBCCDD-0011-2233-4455-66778899AABB'],
        ['date', 'date', '2024-02-29'],
        ['timestamp', 'timestamp', '2026-01-02 03:04:05.123456'],
        ['timestamptz', 'timestamptz', '2026-01-02 03:04:05.123456+00'],
        ['json', 'json', '{"n":9007199254740993,"null":null}'],
        ['jsonb', 'jsonb', '{"b":2,"n":9007199254740993,"a":1.00}'],
        ['bytea', 'bytea', '\\x00ff'],
      ] as const;
      for (const [type, sqlType, input] of cases) {
        const result = await client.query<{ value: string }>(
          `SELECT $1::${sqlType}::text AS value`,
          [input],
        );
        const observed = result.rows[0]?.value;
        if (observed === undefined)
          throw new Error('Missing source observation.');
        expect(valueIdentity(scalarValue(type, observed))).toBe(
          valueIdentity(scalarValue(type, input)),
        );
      }
      const equality = await client.query<{ equal: boolean }>(
        'SELECT $1::jsonb=$2::jsonb AS equal',
        ['{"a":1.00,"b":9007199254740993}', '{"b":9007199254740993,"a":1e0}'],
      );
      expect(equality.rows).toEqual([{ equal: true }]);
      for (const input of [
        '"\\u0000"',
        '"\\ud800"',
        '{"\\udfff":1}',
        '1e200000',
        '1e-16384',
      ]) {
        await expect(
          client.query('SELECT $1::jsonb', [input]),
        ).rejects.toThrow();
        expect(() => scalarValue('jsonb', input)).toThrow();
        await expect(
          client.query('SELECT $1::json::text', [input]),
        ).resolves.toBeDefined();
      }
    } finally {
      await client.end();
    }
  });
});
