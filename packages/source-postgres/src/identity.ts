import type pg from 'pg';
import type { ReplicationClientConfig } from 'pg-logical-replication';
import { HistoryError } from '@time-travel-sql/sdk';
import type { Position } from '@time-travel-sql/sdk';
import { connectionOptions, textRows } from './connection.js';
import type { PostgresConnection } from './connection.js';
import { withPostgresClient } from './owned-client.js';
import { decodeLsn } from './identifiers.js';

export interface PostgresIdentity {
  readonly systemId: string;
  readonly timeline: string;
  readonly database: string;
  readonly position: Position;
}

/** Must run on the actual replication connection before creating/using a slot. */
export async function identifySystem(
  client: pg.Client,
  databaseName: string,
): Promise<PostgresIdentity> {
  const rows = textRows(
    (await client.query({ text: 'IDENTIFY_SYSTEM', rowMode: 'array' })).rows,
  );
  const [systemId, timeline, lsn, database] = rows[0] ?? [];
  if (
    rows.length !== 1 ||
    rows[0]?.length !== 4 ||
    !systemId ||
    !/^[1-9][0-9]{0,19}$/.test(systemId) ||
    BigInt(systemId) > 18446744073709551615n ||
    !timeline ||
    !/^[1-9][0-9]{0,9}$/.test(timeline) ||
    BigInt(timeline) > 4294967295n ||
    !database ||
    database !== databaseName
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Replication server returned an invalid cluster identity.',
    );
  return Object.freeze({
    systemId,
    timeline,
    database,
    position: decodeLsn(lsn),
  });
}

/** Read-only replication authentication and identity probe; no slots are created. */
export async function inspectPostgresIdentity(
  connection: PostgresConnection,
  signal: AbortSignal,
): Promise<PostgresIdentity> {
  const config: ReplicationClientConfig = {
    ...connectionOptions(connection),
    replication: 'database',
  };
  return withPostgresClient(config, signal, (client) =>
    identifySystem(client, connection.database),
  );
}
