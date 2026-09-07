import { HistoryError, decodeRecordingMetadata } from '@time-travel-sql/sdk';
import type {
  RecordingMetadata,
  RecordingImport,
  CancellationSignal,
} from '@time-travel-sql/sdk';
import type { Client } from './client.js';
import type { ImportDirectories } from './import-directories.js';

/** The shared flag also reaches synchronous worker-side publication loops. */
export async function beginImport(
  client: Client,
  directories: ImportDirectories,
  input: RecordingMetadata,
  signal: CancellationSignal,
): Promise<RecordingImport> {
  const metadata = decodeRecordingMetadata(input);
  const cancellation = new SharedArrayBuffer(4);
  const flag = new Int32Array(cancellation);
  const cancelled = () => Atomics.store(flag, 0, 1);
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (signal.aborted) {
      cancelled();
      throw new HistoryError('CANCELLED', 'Recording import cancelled.');
    }
    const onAbort = () => cancelled();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await operation();
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
  if (signal.aborted)
    throw new HistoryError('CANCELLED', 'Recording import cancelled.');
  const root = directories.create();
  const discardAfterFailure = async (
    primary: unknown,
    stopWorker: boolean,
  ): Promise<never> => {
    const errors = [primary];
    if (stopWorker) {
      try {
        await client.close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await directories.release(root);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw primary;
    throw new AggregateError(errors, 'Import cleanup failed.');
  };
  let token: string;
  try {
    token = await run(() =>
      client.request({
        method: 'beginImport',
        args: [metadata, cancellation, root],
      }),
    );
  } catch (error) {
    return discardAfterFailure(error, client.isClosed);
  }
  let closing: Promise<void> | undefined;
  let published = false;
  const active = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing || published)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Import session is closed or published.',
      );
    return run(operation);
  };
  const stage: RecordingImport = {
    stageBaseline: (rows) =>
      active(() =>
        client.request({ method: 'importBaseline', args: [token, rows] }),
      ),
    publishBaseline: (position) =>
      active(() =>
        client.request({
          method: 'importBaselineComplete',
          args: [token, position],
        }),
      ),
    append: (transaction) =>
      active(() =>
        client.request({ method: 'importAppend', args: [token, transaction] }),
      ),
    publish: (expected) =>
      active(async () => {
        const info = await client.request({
          method: 'publishImport',
          args: [token, expected],
        });
        published = true;
        return info;
      }),
    close: () => {
      closing ??= (async () => {
        try {
          await client.request({ method: 'closeImport', args: [token] });
        } catch (error) {
          return discardAfterFailure(error, true);
        }
        await directories.release(root);
      })();
      return closing;
    },
  };
  if (signal.aborted) {
    await stage.close();
    throw new HistoryError('CANCELLED', 'Recording import cancelled.');
  }
  return stage;
}
