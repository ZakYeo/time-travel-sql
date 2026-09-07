import { LogicalReplicationService } from 'pg-logical-replication';
import { HistoryError, decodePosition } from '@time-travel-sql/sdk';
import type {
  HistoryState,
  SourceStream,
  SourceStreamStatus,
} from '@time-travel-sql/sdk';
import type { PostgresConnection } from './connection.js';
import { connectionOptions } from './connection.js';
import { inspectPostgresCapture } from './preflight.js';
import { PostgresTransactions } from './transactions.js';
import type { PostgresTransactionLimits } from './transaction-limits.js';
import { PgoutputFrame } from './pgoutput.js';
import { encodeLsn } from './identifiers.js';
import { VerifiedStreamPlugin } from './stream-plugin.js';
import { StreamDelivery } from './stream-delivery.js';

export interface PostgresStreamOptions {
  readonly connection: PostgresConnection;
  readonly slot: string;
  readonly publication: string;
  readonly systemId: string;
  readonly timeline: string;
  readonly databaseOid: string;
  readonly state: HistoryState;
  readonly signal: AbortSignal;
  readonly transactionLimits?: PostgresTransactionLimits;
  /** Maximum wait after preflight for replication start or acknowledgement; defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

export async function openPostgresStream(
  options: PostgresStreamOptions,
): Promise<SourceStream> {
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
    throw new HistoryError(
      'INVALID_VALUE',
      'Stream timeout must be 1–30000 milliseconds.',
    );
  const assembler = new PostgresTransactions(
    options.state,
    options.transactionLimits,
  );
  const recording = options.state.recording;
  await inspectPostgresCapture({
    connection: options.connection,
    publication: options.publication,
    schemaId: recording.schema.id,
    tables: recording.schema.tables,
    signal: options.signal,
    resume: {
      slot: options.slot,
      systemId: options.systemId,
      timeline: options.timeline,
      databaseOid: options.databaseOid,
      durablePosition: options.state.position,
      schema: recording.schema,
    },
  });
  if (options.signal.aborted)
    throw new HistoryError('CANCELLED', 'PostgreSQL stream was cancelled.');
  const service = new LogicalReplicationService(
    connectionOptions(options.connection),
    {
      acknowledge: { auto: false, timeoutSeconds: 0 },
      flowControl: { enabled: true },
    },
  );
  const delivery = new StreamDelivery();
  const ready = Promise.withResolvers<void>();
  let phase: SourceStreamStatus['state'] = 'streaming';
  let received = options.state.position;
  let terminal: HistoryError | undefined;
  let closing: Promise<void> | undefined;
  let acknowledging = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = (
    error = new HistoryError('CANCELLED', 'PostgreSQL stream was closed.'),
  ): Promise<void> => {
    if (!terminal) {
      terminal = error;
      phase = error.code === 'CANCELLED' ? 'closed' : 'failed';
      clearTimeout(deadline);
      options.signal.removeEventListener('abort', abort);
      delivery.fail(error);
      assembler.close();
      ready.reject(error);
    }
    closing ??= service.destroy().then(
      () => undefined,
      (cause: unknown) => {
        throw new HistoryError(
          'STORAGE_FAILURE',
          'PostgreSQL stream cleanup failed.',
          { cause },
        );
      },
    );
    return closing;
  };
  const fail = (error: unknown): void => {
    const failure =
      error instanceof HistoryError
        ? error
        : new HistoryError('STORAGE_FAILURE', 'PostgreSQL stream failed.', {
            cause: error,
          });
    void stop(failure).catch(() => {
      /* The close promise retains the cleanup error for the owner. */
    });
  };
  const abort = () =>
    fail(new HistoryError('CANCELLED', 'PostgreSQL stream was cancelled.'));
  const arm = (message: string): void => {
    clearTimeout(deadline);
    deadline = setTimeout(
      () => fail(new HistoryError('LIMIT_EXCEEDED', message)),
      timeout,
    );
  };
  const acknowledgeDurable = async (): Promise<void> => {
    const durable = assembler.durableState.position;
    const lastByte = decodePosition((BigInt(durable) - 1n).toString());
    if (!(await service.acknowledge(encodeLsn(lastByte))))
      throw new HistoryError(
        'STORAGE_FAILURE',
        'Replication connection cannot acknowledge durable progress.',
      );
  };
  service.on('error', fail);
  service.on('start', () => {
    clearTimeout(deadline);
    ready.resolve();
  });
  service.on('heartbeat', (_lsn, _time, requested) => {
    if (requested && !terminal) void acknowledgeDurable().catch(fail);
  });
  service.on('data', async (_lsn: string, input: unknown) => {
    if (terminal) return;
    try {
      if (!(input instanceof PgoutputFrame))
        throw new HistoryError(
          'INVALID_EVENT',
          'Unexpected replication frame.',
        );
      const transaction = assembler.push(input);
      if (transaction) {
        received = transaction.position;
        phase = 'waiting-for-durable';
        arm('Timed out waiting for durable transaction acknowledgement.');
        await delivery.publish(transaction);
      }
    } catch (error) {
      fail(error);
    }
  });
  options.signal.addEventListener('abort', abort, { once: true });
  arm('Timed out starting PostgreSQL replication.');
  const plugin = new VerifiedStreamPlugin(options.publication, {
    systemId: options.systemId,
    timeline: options.timeline,
    database: options.connection.database,
  });
  // Observe subscription failure without awaiting a driver connect promise that can
  // remain pending after cancellation. stop() owns and awaits socket cleanup.
  void service
    .subscribe(plugin, options.slot, encodeLsn(options.state.position))
    .then(() => {
      if (!terminal)
        fail(
          new HistoryError(
            'INVALID_HISTORY',
            'Replication stream ended unexpectedly.',
          ),
        );
    }, fail);
  try {
    await ready.promise;
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    recording,
    next: () => delivery.next(),
    async acknowledge(position) {
      try {
        if (acknowledging)
          throw new HistoryError(
            'INVALID_HISTORY',
            'Durable acknowledgement is already in progress.',
          );
        delivery.require(position);
        acknowledging = true;
        assembler.confirmDurable(position);
        await acknowledgeDurable();
        if (terminal) throw terminal;
        clearTimeout(deadline);
        phase = 'streaming';
        delivery.release();
      } catch (error) {
        fail(error);
        throw error;
      } finally {
        acknowledging = false;
      }
    },
    status: () =>
      Object.freeze({
        state: phase,
        durablePosition: assembler.durableState.position,
        receivedPosition: received,
      }),
    close: () => stop(),
  };
}
