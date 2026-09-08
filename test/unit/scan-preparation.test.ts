import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { scanCheck } from '../../apps/cli/dist/scan.js';

it('reports requested selections and zero evaluations when preparation is cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    scanCheck(
      resolve('/tmp/tts-cancelled-preparation/history.sqlite'),
      ['recording', 'check', 'baseline', 'after:10'],
      {},
      1000,
      controller.signal,
    ),
  ).rejects.toMatchObject({
    code: 'CANCELLED',
    report: {
      phase: 'preparing',
      recordingId: 'recording',
      checkId: 'check',
      requestedRange: {
        from: { kind: 'baseline' },
        to: { kind: 'after', position: '10' },
      },
      progress: { evaluatedStates: 0, lastEvaluatedPosition: null },
      outcome: { kind: 'incomplete', reason: 'cancelled' },
    },
  });
});
