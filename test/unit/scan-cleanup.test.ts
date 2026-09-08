import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { decodeSavedCheck } from '@time-travel-sql/sdk';
import { scanCheck } from '../../apps/cli/dist/scan.js';
import { fixture, seed } from '../../test-support/exchange-fixture.js';
import { metadata } from '../../test-support/storage-fixture.js';

const { controller } = vi.hoisted(() => ({
  controller: new AbortController(),
}));
// Fault injection at the owned query-engine boundary: successful SQL finishes,
// then cancellation arrives during close, before CLI result delivery.
vi.mock('@time-travel-sql/query-pglite', () => ({
  createHistoricalQueryEngine: () => ({
    query: async () => ({ columns: [], rows: [] }),
    close: async () => {
      controller.abort();
    },
  }),
}));

it('preserves completed progress when cancellation arrives during successful engine cleanup', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await source.saveCheck(
      metadata.id,
      decodeSavedCheck({
        id: 'clear',
        name: 'Clear',
        query: { sql: 'SELECT 1 WHERE false' },
      }),
    );
    await expect(
      scanCheck(
        join(root, 'source.sqlite'),
        ['recording', 'clear', 'baseline', 'after:10'],
        {},
        10000,
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
      report: {
        range: { from: '0', to: '10' },
        progress: { evaluatedStates: 2, lastEvaluatedPosition: '10' },
        outcome: { kind: 'incomplete', reason: 'cancelled' },
      },
    });
  });
});
