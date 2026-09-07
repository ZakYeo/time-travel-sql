import type pg from 'pg';
import { HistoryError } from '@time-travel-sql/sdk';

/** The owner closes the client on abort. pg.end() alone may never settle connect(). */
export async function connectClient(
  client: pg.Client,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted)
    throw new HistoryError(
      'CANCELLED',
      'PostgreSQL connection startup was cancelled.',
    );
  await new Promise<void>((resolve, reject) => {
    const abort = () =>
      reject(
        new HistoryError(
          'CANCELLED',
          'PostgreSQL connection startup was cancelled.',
        ),
      );
    signal.addEventListener('abort', abort, { once: true });
    void client.connect().then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
