import pg from 'pg';
import { postgresFailure, postgresCancellation } from './source-errors.js';
import { connectClient } from './connect.js';

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/** Owns cancellation, connection errors and cleanup for a bounded SQL operation. */
export async function withPostgresClient<T>(
  config: pg.ClientConfig,
  signal: AbortSignal,
  operation: (client: pg.Client) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw postgresCancellation(signal);
  const client = new pg.Client(config);
  let connectionError: unknown;
  client.on('error', (error: Error) => {
    connectionError = error;
  });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= client.end());
  const abort = () => {
    void close().catch((error: unknown) => {
      connectionError = error;
    });
  };
  signal.addEventListener('abort', abort, { once: true });
  let outcome: Outcome<T>;
  try {
    await connectClient(client, signal);
    outcome = { ok: true, value: await operation(client) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  signal.removeEventListener('abort', abort);
  try {
    await close();
  } catch (error) {
    outcome = {
      ok: false,
      error: new AggregateError(
        outcome.ok ? [error] : [outcome.error, error],
        'PostgreSQL cleanup failed.',
      ),
    };
  }
  if (outcome.ok && connectionError)
    outcome = { ok: false, error: connectionError };
  if (!outcome.ok) {
    const failure = postgresFailure(
      outcome.error,
      'PostgreSQL operation failed; check connectivity, objects and permissions.',
    );
    if (
      signal.aborted &&
      (failure.code === 'CANCELLED' || failure.code === 'SOURCE_UNAVAILABLE')
    )
      throw postgresCancellation(signal);
    throw failure;
  }
  if (signal.aborted) throw postgresCancellation(signal);
  return outcome.value;
}
