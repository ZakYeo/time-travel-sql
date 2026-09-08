import {
  decodeTransactionContext,
  TRANSACTION_CONTEXT_MAX_BYTES,
  HistoryError,
} from '@time-travel-sql/sdk';
import type { TransactionContext } from '@time-travel-sql/sdk';
import type { Pgoutput } from 'pg-logical-replication';
import type pg from 'pg';
import { Sql } from '@time-travel-sql/sql-postgres';
import { decodeLsn } from './identifiers.js';

export const POSTGRES_CONTEXT_PREFIX = 'tts.context.v1';

/** Caller supplies its existing transaction's connected client; no lifecycle is owned here. */
export async function emitPostgresContext(
  client: Pick<pg.Client, 'query'>,
  input: unknown,
): Promise<void> {
  const context = decodeTransactionContext(input);
  await client.query({
    text: Sql.query`SELECT pg_catalog.pg_logical_emit_message(true, ${Sql.parameter(1)}, ${Sql.parameter(2)}::text)`
      .text,
    values: [POSTGRES_CONTEXT_PREFIX, JSON.stringify(context)],
  });
}

/** Only the recognized transactional prefix can supply context to the enclosing commit. */
export function postgresTransactionContext(
  message: Pgoutput.MessageMessage,
): TransactionContext {
  if (
    message.prefix !== POSTGRES_CONTEXT_PREFIX ||
    message.flags !== 1 ||
    message.transactional !== true
  )
    throw new HistoryError(
      'INVALID_EVENT',
      'Context must be a transactional logical message.',
    );
  decodeLsn(message.messageLsn);
  if (
    !(message.content instanceof Uint8Array) ||
    message.content.byteLength > TRANSACTION_CONTEXT_MAX_BYTES
  )
    throw new HistoryError(
      'LIMIT_EXCEEDED',
      'Transaction context message exceeds its byte limit.',
    );
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(message.content),
    );
  } catch {
    // JSON parser diagnostics can quote payload bytes; do not retain that cause.
    throw new HistoryError(
      'INVALID_EVENT',
      'Malformed transaction context message.',
    );
  }
  return decodeTransactionContext(input);
}
