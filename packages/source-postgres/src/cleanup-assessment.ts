import { HistoryError } from '@time-travel-sql/sdk';
import type { Position } from '@time-travel-sql/sdk';
import type { PostgresConnection } from './connection.js';
import { textRows } from './connection.js';
import { withPostgresCleanupSource } from './cleanup-source.js';
import { decodePostgresSetupReceipt } from './setup-receipt.js';
import { publicationOwnershipComment } from './setup-plan.js';
import { decodeLsn } from './identifiers.js';
import { Sql } from '@time-travel-sql/sql-postgres';

export interface PostgresCleanupSlot {
  readonly configuration: 'compatible' | 'different';
  readonly active: boolean;
  readonly restartPosition: Position | null;
  readonly confirmedPosition: Position | null;
  readonly walStatus: 'reserved' | 'extended' | 'unreserved' | 'lost' | null;
  /** Exact current-WAL minus restart position, not disk allocation. */
  readonly retainedWalBytes: string | null;
  /** Exact current-WAL minus confirmed position, not a count of captured events. */
  readonly unconfirmedWalBytes: string | null;
}
export interface PostgresCleanupAssessment {
  readonly publication: 'owned' | 'absent' | 'different';
  readonly slot: PostgresCleanupSlot | null;
  readonly currentPosition: Position;
  readonly nextAction:
    | 'nothing-to-remove'
    | 'cleanup-publication'
    | 'review-publication-ownership'
    | 'review-slot-ownership';
}

function walDistance(
  current: Position,
  position: Position | null,
): string | null {
  if (position === null) return null;
  if (BigInt(position) > BigInt(current))
    throw new HistoryError(
      'INVALID_HISTORY',
      'Source progress changed inconsistently during cleanup assessment.',
    );
  return (BigInt(current) - BigInt(position)).toString();
}

/** Read-only observations, not a slot-deletion capability. Existing slots always
 * require ownership review: PostgreSQL exposes no atomic incarnation check/drop.
 * Does not acquire capture locks, so an active recorder remains inspectable.
 */
export async function assessPostgresCleanup(
  connection: PostgresConnection,
  input: unknown,
  signal: AbortSignal,
): Promise<PostgresCleanupAssessment> {
  const receipt = decodePostgresSetupReceipt(input);
  return withPostgresCleanupSource(
    connection,
    receipt,
    signal,
    async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const publications = textRows(
        (
          await client.query({
            text: Sql.query`SELECT oid::text, pubname, pg_catalog.obj_description(oid, 'pg_publication')
      FROM pg_catalog.pg_publication WHERE pubname=${Sql.literal(receipt.publication)} OR oid=${Sql.literal(receipt.publicationOid)}::oid`
              .text,
            rowMode: 'array',
          })
        ).rows,
      );
      const publication = !publications.length
        ? 'absent'
        : publications.length === 1 &&
            publications[0]?.[0] === receipt.publicationOid &&
            publications[0][1] === receipt.publication &&
            publications[0][2] ===
              publicationOwnershipComment(receipt.ownershipToken, receipt.slot)
          ? 'owned'
          : 'different';
      const rows = textRows(
        (
          await client.query({
            text: Sql.query`SELECT plugin, slot_type, datoid::text, temporary::text, active::text,
      restart_lsn::text, confirmed_flush_lsn::text, wal_status, two_phase::text
      FROM pg_catalog.pg_replication_slots WHERE slot_name=${Sql.literal(receipt.slot)}`
              .text,
            rowMode: 'array',
          })
        ).rows,
      );
      // Read current WAL after the slot observation; a consistent primary cannot have
      // acknowledged or retained a position beyond this later observation.
      const currentPosition = decodeLsn(
        textRows(
          (
            await client.query({
              text: 'SELECT pg_current_wal_lsn()::text',
              rowMode: 'array',
            })
          ).rows,
        )[0]?.[0],
      );
      if (rows.length > 1)
        throw new HistoryError(
          'INVALID_HISTORY',
          'Ambiguous replication slot observation.',
        );
      let slot: PostgresCleanupSlot | null = null;
      const row = rows[0];
      if (row) {
        const [
          plugin,
          type,
          database,
          temporary,
          active,
          restart,
          confirmed,
          walStatus,
          twoPhase,
        ] = row;
        if (
          (active !== 'true' && active !== 'false') ||
          (walStatus !== null &&
            walStatus !== 'reserved' &&
            walStatus !== 'extended' &&
            walStatus !== 'unreserved' &&
            walStatus !== 'lost')
        )
          throw new HistoryError(
            'INVALID_HISTORY',
            'Invalid replication slot observation.',
          );
        const restartPosition = restart === null ? null : decodeLsn(restart);
        const confirmedPosition =
          confirmed === null ? null : decodeLsn(confirmed);
        slot = Object.freeze({
          configuration:
            plugin === 'pgoutput' &&
            type === 'logical' &&
            database === receipt.databaseOid &&
            temporary === 'false' &&
            twoPhase === 'false'
              ? 'compatible'
              : 'different',
          active: active === 'true',
          restartPosition,
          confirmedPosition,
          walStatus,
          retainedWalBytes: walDistance(currentPosition, restartPosition),
          unconfirmedWalBytes: walDistance(currentPosition, confirmedPosition),
        });
      }
      await client.query('COMMIT');
      return Object.freeze({
        publication,
        slot,
        currentPosition,
        nextAction: slot
          ? 'review-slot-ownership'
          : publication === 'different'
            ? 'review-publication-ownership'
            : publication === 'owned'
              ? 'cleanup-publication'
              : 'nothing-to-remove',
      });
    },
  );
}
