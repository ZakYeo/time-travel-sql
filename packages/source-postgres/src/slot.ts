import type pg from 'pg';
import { HistoryError, decodePosition } from '@time-travel-sql/sdk';
import type { Position } from '@time-travel-sql/sdk';
import { textRows } from './connection.js';
import { decodeLsn, validateSlotName } from './identifiers.js';

export interface PostgresSlot {
  readonly name: string;
  readonly restartPosition: Position;
  readonly confirmedPosition: Position;
  readonly walStatus: 'reserved' | 'extended';
}

/** Continuity check only: a name is not proof of resource ownership. */
export async function inspectSlot(
  client: pg.Client,
  name: string,
  databaseOid: string,
  durablePosition: Position,
): Promise<PostgresSlot> {
  validateSlotName(name);
  const durable = decodePosition(durablePosition);
  const rows = textRows(
    (
      await client.query({
        text: `SELECT plugin, slot_type, datoid::text, temporary::text, active::text,
      restart_lsn::text, confirmed_flush_lsn::text, wal_status, two_phase::text, conflicting::text, pg_current_wal_lsn()::text
      FROM pg_catalog.pg_replication_slots WHERE slot_name=$1`,
        values: [name],
        rowMode: 'array',
      })
    ).rows,
  );
  const row = rows[0];
  if (!row || rows.length !== 1)
    throw new HistoryError(
      'INVALID_HISTORY',
      'The retained replication slot is missing; do not create a replacement to resume.',
    );
  const [
    plugin,
    type,
    database,
    temporary,
    active,
    restart,
    confirmed,
    status,
    twoPhase,
    conflicting,
    current,
  ] = row;
  if (
    plugin !== 'pgoutput' ||
    type !== 'logical' ||
    database !== databaseOid ||
    temporary !== 'false' ||
    twoPhase !== 'false' ||
    conflicting === 'true'
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Replication slot configuration differs from the required persistent pgoutput slot.',
    );
  if (active !== 'false')
    throw new HistoryError(
      'INVALID_HISTORY',
      'Replication slot is already active in another session.',
    );
  if (status !== 'reserved' && status !== 'extended')
    throw new HistoryError(
      'INVALID_HISTORY',
      'Required WAL is lost or no longer reserved; recording coverage cannot safely resume.',
    );
  const restartPosition = decodeLsn(restart);
  const confirmedPosition = decodeLsn(confirmed);
  if (
    BigInt(restartPosition) > BigInt(durable) ||
    BigInt(confirmedPosition) > BigInt(durable) ||
    BigInt(durable) > BigInt(decodeLsn(current))
  )
    throw new HistoryError(
      'INVALID_HISTORY',
      'Replication slot or local durable progress lies outside the retained source range.',
    );
  return Object.freeze({
    name,
    restartPosition,
    confirmedPosition,
    walStatus: status,
  });
}
