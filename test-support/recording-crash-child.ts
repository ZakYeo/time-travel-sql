import {
  openLocalStore,
  createLocalReconstructor,
} from '@time-travel-sql/storage-local';
import { resumeRecording } from '@time-travel-sql/sdk';
import { createPostgresResumeProvider } from '@time-travel-sql/source-postgres';
import type { CrashOptions, CrashPoint } from './recording-crash-process.js';

/** Test-only IPC barriers surround real adapter operations; the parent sends SIGKILL. */
async function run(options: CrashOptions): Promise<void> {
  const pause = async (point: CrashPoint, position: string): Promise<void> => {
    if (options.point !== point) return;
    process.send?.({ kind: 'barrier', position });
    await new Promise<void>(() => {
      /* Intentionally terminated by the parent. */
    });
  };
  const store = await openLocalStore({ path: options.path });
  const reconstructor = createLocalReconstructor({ path: options.path });
  const provider = createPostgresResumeProvider(options.connection);
  const session = await resumeRecording(
    {
      ...store,
      async prepareRecording(id) {
        const claim = await store.prepareRecording(id);
        return {
          ...claim,
          async activate() {
            const writer = await claim.activate();
            return {
              ...writer,
              async append(key, transaction) {
                await pause('before-append', transaction.position);
                const result = await writer.append(key, transaction);
                await pause('after-append', transaction.position);
                return result;
              },
            };
          },
        };
      },
    },
    reconstructor,
    {
      async acquire(recording, binding, signal) {
        const lease = await provider.acquire(recording, binding, signal);
        return {
          ...lease,
          async openStream(state) {
            const stream = await lease.openStream(state);
            return {
              ...stream,
              async acknowledge(position) {
                await stream.acknowledge(position);
                await pause('after-ack', position);
              },
            };
          },
        };
      },
    },
    'recording',
  );
  process.send?.({ kind: 'ready' });
  await session.done;
  throw new Error('Crash fixture unexpectedly completed.');
}

process.once('message', (options: CrashOptions) => {
  void run(options).catch(() => {
    process.send?.({ kind: 'error' });
    process.exitCode = 1;
    process.disconnect();
  });
});
