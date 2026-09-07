import { HistoryError } from '@time-travel-sql/sdk';
import type { PostgresConnection } from './connection.js';
import { textRows } from './connection.js';
import { withPostgresCleanupSource } from './cleanup-source.js';
import { quoteIdentifier } from './identifiers.js';
import { decodePostgresSetupReceipt } from './setup-receipt.js';
import { publicationOwnershipComment } from './setup-plan.js';
import { acquireCaptureLocks } from './capture-locks.js';

/** Explicitly removes only the receipted publication; slot cleanup must precede it.
 * Table replica identity is shared configuration and is not changed here.
 */
export async function cleanupPostgresPublication(
  connection: PostgresConnection,
  input: unknown,
  signal: AbortSignal,
): Promise<'removed' | 'absent'> {
  const receipt = decodePostgresSetupReceipt(input);
  return withPostgresCleanupSource(
    connection,
    receipt,
    signal,
    async (client) => {
      // Replication connections support simple SQL only. Interpolated values below
      // are canonical decimal IDs or names restricted to lowercase ASCII/underscores.
      await acquireCaptureLocks(client, receipt);
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='30s'");
      const slot = textRows(
        (
          await client.query({
            text: `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_replication_slots WHERE slot_name='${receipt.slot}')::text`,
            rowMode: 'array',
          })
        ).rows,
      )[0]?.[0];
      if (slot !== 'false')
        throw new HistoryError(
          'INVALID_HISTORY',
          'The intended slot still exists; clean up its proven ownership before removing the publication.',
        );
      const rows = textRows(
        (
          await client.query({
            text: `SELECT oid::text, pubname FROM pg_catalog.pg_publication
      WHERE pubname='${receipt.publication}' OR oid=${receipt.publicationOid}`,
            rowMode: 'array',
          })
        ).rows,
      );
      if (!rows.length) {
        await client.query('COMMIT');
        return 'absent';
      }
      if (
        rows.length !== 1 ||
        rows[0]?.[0] !== receipt.publicationOid ||
        rows[0][1] !== receipt.publication
      )
        throw new HistoryError(
          'INVALID_HISTORY',
          'Publication was renamed or replaced; cleanup refused.',
        );
      const candidate = `tts_cleanup_${receipt.ownershipToken}`;
      const temporary =
        candidate === receipt.publication ? `${candidate}_drop` : candidate;
      // RENAME obtains AccessExclusiveLock on the resolved object until commit.
      // Recheck after that lock: a concurrent replacement must be rolled back.
      await client.query(
        `ALTER PUBLICATION ${quoteIdentifier(receipt.publication)} RENAME TO ${quoteIdentifier(temporary)}`,
      );
      const locked = textRows(
        (
          await client.query({
            text: `SELECT oid::text, pg_catalog.obj_description(oid, 'pg_publication'),
      EXISTS(SELECT 1 FROM pg_catalog.pg_replication_slots WHERE slot_name='${receipt.slot}')::text
      FROM pg_catalog.pg_publication WHERE pubname='${temporary}'`,
            rowMode: 'array',
          })
        ).rows,
      )[0];
      if (
        locked?.[0] !== receipt.publicationOid ||
        locked[1] !==
          publicationOwnershipComment(receipt.ownershipToken, receipt.slot)
      )
        throw new HistoryError(
          'INVALID_HISTORY',
          'Locked publication identity or ownership marker differs; cleanup refused.',
        );
      if (locked[2] !== 'false')
        throw new HistoryError(
          'INVALID_HISTORY',
          'The intended slot appeared during cleanup; publication removal refused.',
        );
      signal.throwIfAborted();
      await client.query(`DROP PUBLICATION ${quoteIdentifier(temporary)}`);
      await client.query('COMMIT');
      return 'removed';
    },
  );
}
