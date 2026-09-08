import { validateSlotName } from './identifiers.js';
import { withPostgresClient } from './owned-client.js';
import { inspectPostgresIdentity } from './identity.js';
import {
  HistoryError,
  schemaWithoutColumnPolicy,
  applyColumnPolicy,
  recordedColumnPolicy,
} from '@time-travel-sql/sdk';
import type { Schema, Position, ColumnPolicy } from '@time-travel-sql/sdk';
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
  readonly newSlot?: string;
  readonly columnPolicy?: ColumnPolicy;
  readonly resume?: {
    readonly systemId: string;
    readonly timeline: string;
    readonly slot: string;
    readonly databaseOid: string;
    readonly durablePosition: Position;
    readonly schema: Schema;
  };
}
export interface PostgresPreflight {
  readonly systemId: string;
  readonly timeline: string;
  readonly databaseOid: string;
  readonly schema: Schema;
  readonly slot: PostgresSlot | null;
}

/** Read-only point-in-time preflight; does not establish exclusive ownership. */
export async function inspectPostgresCapture(
  options: PostgresPreflightOptions,
): Promise<PostgresPreflight> {
  if (options.newSlot !== undefined) {
    validateSlotName(options.newSlot);
    if (options.resume)
      throw new HistoryError(
        'INVALID_VALUE',
        'Choose new-slot or resume preflight, not both.',
      );
  }
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
  const identity = await inspectPostgresIdentity(
    options.connection,
    options.signal,
  );
  if (
    options.resume &&
    (identity.systemId !== options.resume.systemId ||
      identity.timeline !== options.resume.timeline)
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Cluster identity or timeline differs from the recorded source.',
    );
  return withPostgresClient(
    connectionOptions(options.connection),
    options.signal,
    async (client) => {
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
      if (options.newSlot !== undefined) {
        const observation = textRows(
          (
            await client.query({
              text: `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_replication_slots WHERE slot_name=$1)::text,
            (SELECT count(*) FROM pg_catalog.pg_replication_slots)::text`,
              values: [options.newSlot],
              rowMode: 'array',
            })
          ).rows,
        )[0];
        if (observation?.[0] !== 'false')
          throw new HistoryError(
            'INVALID_HISTORY',
            'Configured slot already exists; new capture requires an unused slot name.',
          );
        if (Number(observation[1]) >= Number(slots))
          throw new HistoryError(
            'LIMIT_EXCEEDED',
            'No replication slot capacity is currently available.',
          );
      }
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
      const schema = applyColumnPolicy(
        postgresSchema(options.schemaId, tables),
        options.columnPolicy ??
          (options.resume && recordedColumnPolicy(options.resume.schema)),
      );
      await inspectPublication(client, options.publication, tables);
      let slot: PostgresSlot | null = null;
      if (options.resume) {
        if (
          JSON.stringify(recordedColumnPolicy(schema)) !==
          JSON.stringify(recordedColumnPolicy(options.resume.schema))
        )
          throw new HistoryError(
            'INVALID_HISTORY',
            'Column policy differs from the recorded source.',
          );
        if (
          databaseOid !== options.resume.databaseOid ||
          JSON.stringify(schemaWithoutColumnPolicy(schema)) !==
            JSON.stringify(schemaWithoutColumnPolicy(options.resume.schema))
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
      return Object.freeze({
        systemId: identity.systemId,
        timeline: identity.timeline,
        databaseOid,
        schema,
        slot,
      });
    },
  );
}
