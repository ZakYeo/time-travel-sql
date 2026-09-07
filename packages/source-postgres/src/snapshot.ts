import { identifySystem } from './identity.js';
import { connectClient } from './connect.js';
import pg from 'pg';
import type { ReplicationClientConfig } from 'pg-logical-replication';
import { HistoryError } from '@time-travel-sql/sdk';
import type { Position } from '@time-travel-sql/sdk';
import { connectionOptions, textRows } from './connection.js';
import type { PostgresConnection } from './connection.js';
import { inspectTable, qualifiedName } from './catalog.js';
import type { PostgresTable, TableSelection } from './catalog.js';
import { decodeLsn, validateSlotName } from './identifiers.js';
import { snapshotQuery } from './snapshot-query.js';

export type SnapshotPart =
  | {
      readonly kind: 'begin';
      readonly position: Position;
      readonly systemId: string;
      readonly timeline: string;
      readonly databaseOid: string;
      readonly tables: readonly PostgresTable[];
    }
  | {
      readonly kind: 'rows';
      readonly tableOid: string;
      readonly rows: readonly (readonly (string | null)[])[];
    }
  | { readonly kind: 'complete' };

export interface SnapshotOptions {
  readonly connection: PostgresConnection;
  readonly slot: string;
  readonly tables: readonly TableSelection[];
  readonly signal: AbortSignal;
  readonly batchSize?: number;
}

/** Staged bootstrap parts. Only `complete` authorizes a caller to publish a baseline.
 * A created persistent slot remains after failure; explicit operator cleanup is required.
 */
export async function* readSnapshot(
  options: SnapshotOptions,
): AsyncGenerator<SnapshotPart> {
  const slot = validateSlotName(options.slot);
  const names = options.tables.map(qualifiedName);
  const batchSize = options.batchSize ?? 16;
  if (
    !names.length ||
    names.length > 64 ||
    new Set(names).size !== names.length
  )
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Select 1–64 distinct tables explicitly.',
    );
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 16)
    throw new HistoryError(
      'LIMIT_EXCEEDED',
      'Snapshot batch size must be 1–16 (up to 16 MiB of row values).',
    );
  options.signal.throwIfAborted();
  const config = connectionOptions(options.connection);
  const replicationConfig: ReplicationClientConfig = {
    ...config,
    replication: 'database',
  };
  const exporter = new pg.Client(replicationConfig);
  const reader = new pg.Client(config);
  const failures: unknown[] = [];
  const recordFailure = (error: Error) => failures.push(error);
  exporter.on('error', recordFailure);
  reader.on('error', recordFailure);
  const abort = () => {
    void close();
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.allSettled([reader.end(), exporter.end()]).then(
      (results) => {
        for (const result of results)
          if (result.status === 'rejected') failures.push(result.reason);
      },
    );
    return closing;
  };
  const settle = async (): Promise<void> => {
    await close();
    if (options.signal.aborted && !failures.includes(options.signal.reason))
      failures.push(options.signal.reason);
    if (failures.length)
      throw new AggregateError(
        failures,
        'Snapshot connection or cleanup failed.',
      );
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    await connectClient(exporter, options.signal);
    options.signal.throwIfAborted();
    await connectClient(reader, options.signal);
    options.signal.throwIfAborted();
    const version = textRows(
      (
        await reader.query({
          text: 'SHOW server_version_num',
          rowMode: 'array',
        })
      ).rows,
    )[0]?.[0];
    if (!version || Number(version) < 160000 || Number(version) >= 170000)
      throw new HistoryError(
        'INVALID_SCHEMA',
        'Capture supports PostgreSQL 16.',
      );
    const identity = await identifySystem(
      exporter,
      options.connection.database,
    );
    const created = textRows(
      (
        await exporter.query({
          text: `CREATE_REPLICATION_SLOT ${slot} LOGICAL pgoutput (SNAPSHOT 'export')`,
          rowMode: 'array',
        })
      ).rows,
    )[0];
    const position = decodeLsn(created?.[1]);
    const snapshot = created?.[2];
    if (!snapshot || !/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/.test(snapshot))
      throw new HistoryError(
        'INVALID_HISTORY',
        'Server did not export a valid logical snapshot.',
      );
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await reader.query(`SET TRANSACTION SNAPSHOT '${snapshot}'`);
    // The exporter must remain idle until import above completes.
    await reader.query(`LOCK TABLE ${names.join(', ')} IN ACCESS SHARE MODE`);
    const databaseOid = textRows(
      (
        await reader.query({
          text: 'SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()',
          rowMode: 'array',
        })
      ).rows,
    )[0]?.[0];
    if (!databaseOid)
      throw new HistoryError('INVALID_HISTORY', 'Missing database identity.');
    const tables: PostgresTable[] = [];
    for (const table of options.tables)
      tables.push(await inspectTable(reader, table));
    options.signal.throwIfAborted();
    yield {
      kind: 'begin',
      position,
      systemId: identity.systemId,
      timeline: identity.timeline,
      databaseOid,
      tables,
    };
    for (const table of tables) {
      await reader.query(
        `DECLARE tts_snapshot NO SCROLL CURSOR FOR ${snapshotQuery(table)}`,
      );
      while (true) {
        options.signal.throwIfAborted();
        const rows = textRows(
          (
            await reader.query({
              text: `FETCH FORWARD ${batchSize} FROM tts_snapshot`,
              rowMode: 'array',
            })
          ).rows,
        );
        if (!rows.length) break;
        if (rows.some((row) => row[0] !== 'true'))
          throw new HistoryError(
            'LIMIT_EXCEEDED',
            'Snapshot row exceeds the 1 MiB value limit.',
          );
        yield {
          kind: 'rows',
          tableOid: table.oid,
          rows: rows.map((row) => row.slice(1)),
        };
      }
      await reader.query('CLOSE tts_snapshot');
    }
    await reader.query('COMMIT');
    options.signal.throwIfAborted();
  } catch (error) {
    failures.unshift(error);
  } finally {
    options.signal.removeEventListener('abort', abort);
    await settle();
  }
  yield { kind: 'complete' };
}
