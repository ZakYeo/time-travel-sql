import pg from 'pg';
import type { ReplicationClientConfig } from 'pg-logical-replication';
import { HistoryError } from '@time-travel-sql/sdk';
import type { Schema } from '@time-travel-sql/sdk';
import type { PostgresConnection } from './connection.js';
import { connectionOptions, textRows } from './connection.js';
import { connectClient } from './connect.js';
import { identifySystem } from './identity.js';
import type { PostgresDatabaseIdentity } from './identity.js';
import { acquireCaptureLocks } from './capture-locks.js';
import { decodePostgresSetupReceipt } from './setup-receipt.js';
import type { PostgresSetupReceipt } from './setup-receipt.js';
import { publicationOwnershipComment } from './setup-plan.js';

export interface PostgresCaptureLease {
  readonly receipt: PostgresSetupReceipt;
  /** Aborts on close, caller cancellation or loss of the owning connection. */
  readonly signal: AbortSignal;
  assertActive(): void;
  close(): Promise<void>;
}

/** Owns one replication connection and two cooperative session advisory locks. */
export async function openPostgresCaptureLease(
  connection: PostgresConnection,
  input: unknown,
  signal: AbortSignal,
): Promise<PostgresCaptureLease> {
  const receipt = decodePostgresSetupReceipt(input);
  const config: ReplicationClientConfig = {
    ...connectionOptions(connection),
    replication: 'database',
    query_timeout: 5000,
  };
  const client = new pg.Client(config);
  const controller = new AbortController();
  let failure: HistoryError | undefined;
  let closing: Promise<void> | undefined;
  let probe: ReturnType<typeof setTimeout> | undefined;
  const stop = (error: HistoryError): Promise<void> => {
    failure ??= error;
    clearTimeout(probe);
    signal.removeEventListener('abort', abort);
    controller.abort(failure);
    closing ??= client.end().catch((cause: unknown) => {
      throw new HistoryError(
        'STORAGE_FAILURE',
        'Capture lease cleanup failed.',
        { cause },
      );
    });
    return closing;
  };
  const fail = (error: HistoryError): void => {
    void stop(error).catch(() => {
      /* close() retains cleanup errors for the owner. */
    });
  };
  const abort = () =>
    fail(new HistoryError('CANCELLED', 'Capture lease was cancelled.'));
  client.on('error', (cause: unknown) =>
    fail(
      new HistoryError('STORAGE_FAILURE', 'Capture lease connection failed.', {
        cause,
      }),
    ),
  );
  client.on('end', () => {
    if (!closing)
      fail(
        new HistoryError('STORAGE_FAILURE', 'Capture lease connection ended.'),
      );
  });
  const assertActive = (): void => {
    if (failure) throw failure;
  };
  const scheduleProbe = (): void => {
    probe = setTimeout(() => {
      void client.query('SELECT 1').then(
        () => {
          if (!failure) scheduleProbe();
        },
        (cause: unknown) =>
          fail(
            new HistoryError(
              'STORAGE_FAILURE',
              'Capture lease health probe failed.',
              { cause },
            ),
          ),
      );
    }, 1000);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    await connectClient(client, controller.signal);
    const identity = await identifySystem(client, connection.database);
    if (
      identity.systemId !== receipt.systemId ||
      identity.timeline !== receipt.timeline
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Capture lease source identity differs from setup.',
      );
    await acquireCaptureLocks(client, receipt);
    const owned = textRows(
      (
        await client.query({
          text: `SELECT d.oid::text, p.oid::text,
      pg_catalog.obj_description(p.oid, 'pg_publication') FROM pg_catalog.pg_database d
      CROSS JOIN pg_catalog.pg_publication p WHERE d.datname=pg_catalog.current_database()
      AND p.pubname='${receipt.publication}'`,
          rowMode: 'array',
        })
      ).rows,
    )[0];
    if (
      owned?.[0] !== receipt.databaseOid ||
      owned[1] !== receipt.publicationOid ||
      owned[2] !==
        publicationOwnershipComment(receipt.ownershipToken, receipt.slot)
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Capture lease publication identity or marker differs from setup.',
      );
    assertActive();
    scheduleProbe();
    return Object.freeze({
      receipt,
      signal: controller.signal,
      assertActive,
      close: () =>
        stop(new HistoryError('CANCELLED', 'Capture lease was closed.')),
    });
  } catch (error) {
    const primary =
      failure ??
      (error instanceof HistoryError
        ? error
        : new HistoryError(
            'STORAGE_FAILURE',
            'Capture lease could not be acquired.',
            { cause: error },
          ));
    try {
      await stop(primary);
    } catch (cleanup) {
      throw new HistoryError(
        'STORAGE_FAILURE',
        'Capture lease startup and cleanup failed.',
        { cause: new AggregateError([primary, cleanup]) },
      );
    }
    throw primary;
  }
}

/** Adapter-local contract check; leases are obtained through the owned factory. */
export function assertCaptureLease(
  lease: PostgresCaptureLease,
  selection: {
    readonly slot: string;
    readonly schema?: Schema;
    readonly publication?: string;
    readonly identity?: PostgresDatabaseIdentity;
  },
): void {
  lease.assertActive();
  const { slot, schema, publication, identity } = selection;
  if (
    lease.receipt.slot !== slot ||
    (publication !== undefined && lease.receipt.publication !== publication) ||
    (schema !== undefined &&
      JSON.stringify(lease.receipt.schema) !== JSON.stringify(schema)) ||
    (identity !== undefined &&
      (identity.systemId !== lease.receipt.systemId ||
        identity.timeline !== lease.receipt.timeline ||
        identity.databaseOid !== lease.receipt.databaseOid))
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Capture options differ from the owned lease.',
    );
}
