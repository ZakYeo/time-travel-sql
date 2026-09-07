import type pg from 'pg';
import type { ReplicationClientConfig } from 'pg-logical-replication';
import { HistoryError } from '@time-travel-sql/sdk';
import type { PostgresConnection } from './connection.js';
import { connectionOptions, textRows } from './connection.js';
import { withPostgresClient } from './owned-client.js';
import { identifySystem } from './identity.js';
import type { PostgresSetupReceipt } from './setup-receipt.js';

/** Verifies the actual connection used by cleanup inspection or mutation. */
export function withPostgresCleanupSource<T>(
  connection: PostgresConnection,
  receipt: PostgresSetupReceipt,
  signal: AbortSignal,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const config: ReplicationClientConfig = {
    ...connectionOptions(connection),
    replication: 'database',
  };
  return withPostgresClient(config, signal, async (client) => {
    const identity = await identifySystem(client, connection.database);
    const environment = textRows(
      (
        await client.query({
          text: `SELECT oid::text, pg_catalog.current_setting('server_version_num')
      FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()`,
          rowMode: 'array',
        })
      ).rows,
    )[0];
    const version = Number(environment?.[1]);
    if (
      identity.systemId !== receipt.systemId ||
      identity.timeline !== receipt.timeline ||
      environment?.[0] !== receipt.databaseOid ||
      !Number.isInteger(version) ||
      version < 160000 ||
      version >= 170000
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Cleanup connection differs in cluster, timeline, database or supported server version.',
      );
    return work(client);
  });
}
