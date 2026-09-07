import { HistoryError } from '@time-travel-sql/sdk';
import type pg from 'pg';
import type { PostgresConnection } from './connection.js';
import { connectionOptions, textRows } from './connection.js';
import { withPostgresClient } from './owned-client.js';
import { inspectPostgresIdentity } from './identity.js';
import type { PostgresIdentity } from './identity.js';
import { inspectTable } from './catalog.js';
import { postgresSchema } from './schema.js';
import { inspectPublication } from './publication.js';
import { planPostgresSetup } from './setup-plan.js';
import type { PostgresSetupOptions, PostgresSetupPlan } from './setup-plan.js';
import type { PostgresSetupReceipt } from './setup-receipt.js';
import { decodePostgresSetupReceipt } from './setup-receipt.js';
import { acquireCaptureLocks } from './capture-locks.js';

/** Explicit source mutation. Never reuses/replaces an existing publication or slot.
 * Table changes and publication creation commit together; closing rolls back failures.
 */
export async function applyPostgresSetup(
  connection: PostgresConnection,
  options: PostgresSetupOptions,
  schemaId: string,
  signal: AbortSignal,
): Promise<PostgresSetupReceipt> {
  const plan = planPostgresSetup(options);
  const identity = await inspectPostgresIdentity(connection, signal);
  return withPostgresClient(
    connectionOptions(connection),
    signal,
    async (client) => {
      await acquireCaptureLocks(client, plan);
      await client.query('BEGIN');
      const existing = textRows(
        (
          await client.query({
            text: `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_publication WHERE pubname=$1)::text,
        EXISTS(SELECT 1 FROM pg_catalog.pg_replication_slots WHERE slot_name=$2)::text`,
            values: [plan.publication, plan.slot],
            rowMode: 'array',
          })
        ).rows,
      )[0];
      if (existing?.[0] !== 'false' || existing[1] !== 'false')
        throw new HistoryError(
          'INVALID_HISTORY',
          'Setup resource names already exist; inspect ownership instead of replacing them.',
        );
      for (const statement of plan.statements) await client.query(statement);
      const receipt = await readReceipt(client, plan, schemaId, identity);
      signal.throwIfAborted();
      await client.query('COMMIT');
      return receipt;
    },
  );
}

/** Read-only recovery after uncertain commit delivery; the token is an ownership
 * marker, not proof of slot ownership or exclusive capture access.
 */
export async function inspectPostgresSetup(
  connection: PostgresConnection,
  options: PostgresSetupOptions,
  schemaId: string,
  signal: AbortSignal,
): Promise<PostgresSetupReceipt> {
  const plan = planPostgresSetup(options);
  const identity = await inspectPostgresIdentity(connection, signal);
  return withPostgresClient(
    connectionOptions(connection),
    signal,
    async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const receipt = await readReceipt(client, plan, schemaId, identity);
      await client.query('COMMIT');
      return receipt;
    },
  );
}

async function readReceipt(
  client: pg.Client,
  plan: PostgresSetupPlan,
  schemaId: string,
  identity: PostgresIdentity,
): Promise<PostgresSetupReceipt> {
  const tables = [];
  for (const table of plan.tables)
    tables.push(await inspectTable(client, table));
  const schema = postgresSchema(schemaId, tables);
  await inspectPublication(client, plan.publication, tables);
  const row = textRows(
    (
      await client.query({
        text: `SELECT d.oid::text, p.oid::text, obj_description(p.oid, 'pg_publication'),
            current_setting('server_version_num'), current_setting('wal_level') FROM pg_catalog.pg_database d
        CROSS JOIN pg_catalog.pg_publication p WHERE d.datname=current_database() AND p.pubname=$1`,
        values: [plan.publication],
        rowMode: 'array',
      })
    ).rows,
  )[0];
  const [databaseOid, publicationOid, marker, version, wal] = row ?? [];
  if (!databaseOid || !publicationOid || marker !== plan.ownershipComment)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Setup publication identity or ownership marker differs.',
    );
  if (
    !version ||
    Number(version) < 160000 ||
    Number(version) >= 170000 ||
    wal !== 'logical'
  )
    throw new HistoryError(
      'INVALID_SCHEMA',
      'Setup requires PostgreSQL 16 with logical WAL enabled.',
    );
  return decodePostgresSetupReceipt({
    systemId: identity.systemId,
    timeline: identity.timeline,
    databaseOid,
    publication: plan.publication,
    publicationOid,
    ownershipToken: plan.ownershipToken,
    slot: plan.slot,
    schema,
  });
}
