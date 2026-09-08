import { expect, it } from 'vitest';
import { join } from 'node:path';
import { createHistoricalQueryEngine } from '@time-travel-sql/query-pglite';
import { createLocalStatePairs } from '@time-travel-sql/storage-local';
import { decodeQueryRequest, decodePosition } from '@time-travel-sql/sdk';
import {
  fixture,
  seed,
  bytesFrom,
} from '../../test-support/exchange-fixture.js';
import { metadata } from '../../test-support/storage-fixture.js';

it('queries exact committed SQLite selections and leaves authoritative export bytes unchanged', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    const before = await bytesFrom(root);
    const provider = createLocalStatePairs({
      path: join(root, 'source.sqlite'),
    });
    const engine = createHistoricalQueryEngine();
    try {
      const states = await provider.open(
        { recordingId: metadata.id, selection: { kind: 'baseline' } },
        {
          recordingId: metadata.id,
          selection: { kind: 'after', position: decodePosition('10') },
        },
      );
      try {
        const request = decodeQueryRequest({
          sql: 'SELECT id FROM orders ORDER BY id',
        });
        expect((await engine.query(states.from, request)).rows).toEqual([
          ['1'],
        ]);
        await expect(
          engine.query(
            states.to,
            decodeQueryRequest({
              sql: 'WITH deleted AS (DELETE FROM orders RETURNING *) SELECT * FROM deleted',
            }),
          ),
        ).rejects.toMatchObject({ code: 'QUERY_REJECTED' });
        expect((await engine.query(states.to, request)).rows).toEqual([
          ['1'],
          ['2'],
        ]);
        expect(await bytesFrom(root)).toEqual(before);
      } finally {
        await states.close();
      }
    } finally {
      await engine.close();
      await provider.close();
    }
  });
});
