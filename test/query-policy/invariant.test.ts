import { expect, it } from 'vitest';
import { decodePosition, scanInvariant } from '@time-travel-sql/sdk';
import { createHistoricalQueryEngine } from '@time-travel-sql/query-pglite';
import {
  invariantFixture,
  request,
  scanControl,
} from '../../test-support/invariant-fixture.js';

it('executes invariant SQL against reconstructed fail-recover-fail history offline', async () => {
  await invariantFixture(async (history, source) => {
    const engine = createHistoricalQueryEngine();
    try {
      await source.remove(history.info.id);
      const first = await scanInvariant(
        history,
        engine,
        request,
        scanControl(),
      );
      expect(first.outcome).toMatchObject({
        kind: 'violation',
        position: '10',
        predecessor: '0',
        rows: { rows: [['2']] },
      });
      const recovered = await scanInvariant(
        history,
        engine,
        { ...request, from: { kind: 'after', position: decodePosition('20') } },
        scanControl(),
      );
      expect(recovered.progress.evaluatedStates).toBe(2);
      expect(recovered.outcome).toMatchObject({
        kind: 'violation',
        position: '30',
        predecessor: '20',
        rows: { rows: [['2']] },
      });
    } finally {
      await engine.close();
    }
  });
}, 60000);
