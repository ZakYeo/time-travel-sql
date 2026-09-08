import { expect, it } from 'vitest';
import { createHistoricalQueryEngine } from '@time-travel-sql/query-pglite';
import { applyColumnPolicy, decodeQueryRequest } from '@time-travel-sql/sdk';
import { pair, recording } from '../../test-support/investigation-fixture.js';

it('denies declared unavailable columns even when the reconstructed table has no rows', async () => {
  const schema = applyColumnPolicy(recording.schema, {
    version: 1,
    rules: [
      {
        namespace: 'public',
        table: 'orders',
        column: 'note',
        action: 'redact',
      },
    ],
  });
  const view = pair([], [], { ...recording, schema }).to;
  const engine = createHistoricalQueryEngine();
  try {
    expect(
      (
        await engine.query(
          view,
          decodeQueryRequest({ sql: 'SELECT count(id) FROM orders' }),
        )
      ).rows,
    ).toEqual([['0']]);
    for (const sql of [
      'SELECT note FROM orders',
      'SELECT count(note) FROM orders',
      'SELECT * FROM orders WHERE false',
    ])
      await expect(
        engine.query(view, decodeQueryRequest({ sql })),
      ).rejects.toMatchObject({ code: 'QUERY_REJECTED' });
  } finally {
    await engine.close();
  }
});
