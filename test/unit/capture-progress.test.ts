import { expect, it } from 'vitest';
import { decodeRecordingInfo, HistoryError } from '@time-travel-sql/sdk';
import { captureProgress } from '../../apps/cli/dist/capture-progress.js';
import { metadata } from '../../test-support/storage-fixture.js';

const info = decodeRecordingInfo({
  ...metadata,
  status: 'stopped',
  baselinePosition: '0',
  baselineRowCount: 0,
  baselineChecksum: 'a'.repeat(64),
  headPosition: '0',
  transactionCount: 0,
});

for (const fail of [false, true]) {
  it(`interrupts stalled progress when capture ${fail ? 'fails' : 'completes'} and preserves the terminal result`, async () => {
    const completion = Promise.withResolvers<typeof info>();
    const entered = Promise.withResolvers<void>();
    const primary = new HistoryError(
      'SOURCE_UNAVAILABLE',
      'Independent capture failure.',
    );
    let deliveryCancelled = false;
    const run = captureProgress(
      {
        done: completion.promise,
        stop: () => completion.promise,
        status: () => ({ phase: 'recording', retries: 0, lastFailure: null }),
      },
      async () => info,
      async (_data, signal) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            deliveryCancelled = true;
            reject(signal.reason);
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      },
      new AbortController().signal,
    );
    const observed = run.then(
      (value) => value,
      (error: unknown) => error,
    );
    await entered.promise;
    if (fail) completion.reject(primary);
    else completion.resolve(info);
    expect(await observed).toBe(fail ? primary : info);
    expect(deliveryCancelled).toBe(true);
  });
}
