import { connectClient } from './connect.js';
import pg from 'pg';
import { HistoryError, decodeSchema } from '@time-travel-sql/sdk';
import type { Schema, Position } from '@time-travel-sql/sdk';
import { connectionOptions, textRows } from './connection.js';
import type { PostgresConnection } from './connection.js';
import { inspectTable, qualifiedName } from './catalog.js';
import type { TableSelection } from './catalog.js';
import { postgresSchema } from './schema.js';
import { inspectPublication } from './publication.js';
import { inspectSlot } from './slot.js';
import type { PostgresSlot } from './slot.js';

export interface PostgresPreflightOptions {
  readonly connection: PostgresConnection;
  readonly publication: string;
  readonly schemaId: string;
  readonly tables: readonly TableSelection[];
  readonly signal: AbortSignal;
  readonly resume?: {
    readonly slot: string;
    readonly databaseOid: string;
    readonly durablePosition: Position;
    readonly schema: Schema;
  };
}
export interface PostgresPreflight {
  readonly databaseOid: string;
  readonly schema: Schema;
  readonly slot: PostgresSlot | null;
}

/** Read-only point-in-time preflight; does not establish exclusive ownership. */
export async function inspectPostgresCapture(
  options: PostgresPreflightOptions,
): Promise<PostgresPreflight> {
  const names = options.tables.map(qualifiedName);
  if (
    !names.length ||
    names.length > 64 ||
    new Set(names).size !== names.length
  )
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Select 1–64 distinct tables explicitly.',
    );
  if (options.signal.aborted)
    throw new HistoryError('CANCELLED', 'PostgreSQL preflight was cancelled.');
  const client = new pg.Client(connectionOptions(options.connection));
  let connectionError: Error | undefined;
  client.on('error', (error: Error) => {
    connectionError = error;
  });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= client.end());
  const abort = () => {
    void close().catch((error: unknown) => {
      connectionError =
        error instanceof Error ? error : new Error('Connection close failed.');
    });
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    await connectClient(client, options.signal);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const settings = textRows(
      (
        await client.query({
          text: `SELECT current_setting('server_version_num'), current_setting('wal_level'),
      pg_is_in_recovery()::text, (r.rolsuper OR r.rolreplication)::text, d.oid::text,
      current_setting('max_replication_slots'), current_setting('max_wal_senders')
      FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_database d
      WHERE r.rolname=current_user AND d.datname=current_database()`,
          rowMode: 'array',
        })
      ).rows,
    )[0];
    const [version, wal, recovery, replication, databaseOid, slots, senders] =
      settings ?? [];
    if (
      !version ||
      Number(version) < 160000 ||
      Number(version) >= 170000 ||
      wal !== 'logical' ||
      recovery !== 'false' ||
      replication !== 'true' ||
      !databaseOid ||
      Number(slots) < 1 ||
      Number(senders) < 1
    )
      throw new HistoryError(
        'INVALID_SCHEMA',
        'Capture requires PostgreSQL 16 primary, logical WAL, replication permission and enabled slots/senders.',
      );
    const tables = [];
    for (const table of options.tables) {
      const access = textRows(
        (
          await client.query({
            text: `SELECT (has_schema_privilege(current_user, $1, 'USAGE') AND has_table_privilege(current_user, $2, 'SELECT'))::text`,
            values: [table.namespace, qualifiedName(table)],
            rowMode: 'array',
          })
        ).rows,
      )[0]?.[0];
      if (access !== 'true')
        throw new HistoryError(
          'INVALID_SCHEMA',
          'Capture requires schema USAGE and SELECT on every selected table.',
        );
      tables.push(await inspectTable(client, table));
    }
    const schema = postgresSchema(options.schemaId, tables);
    await inspectPublication(client, options.publication, tables);
    let slot: PostgresSlot | null = null;
    if (options.resume) {
      if (
        databaseOid !== options.resume.databaseOid ||
        JSON.stringify(schema) !==
          JSON.stringify(decodeSchema(options.resume.schema))
      )
        throw new HistoryError(
          'INVALID_HISTORY',
          'Database or catalog schema differs from the recorded source.',
        );
      slot = await inspectSlot(
        client,
        options.resume.slot,
        databaseOid,
        options.resume.durablePosition,
      );
    }
    await client.query('COMMIT');
    if (options.signal.aborted)
      throw new HistoryError(
        'CANCELLED',
        'PostgreSQL preflight was cancelled.',
      );
    if (connectionError) throw connectionError;
    return Object.freeze({ databaseOid, schema, slot });
  } catch (error) {
    if (options.signal.aborted)
      throw new HistoryError(
        'CANCELLED',
        'PostgreSQL preflight was cancelled.',
      );
    if (error instanceof HistoryError) throw error;
    throw new HistoryError(
      'STORAGE_FAILURE',
      'PostgreSQL preflight failed; check connectivity, selected objects and permissions.',
      { cause: error },
    );
  } finally {
    options.signal.removeEventListener('abort', abort);
    await close();
  }
}
