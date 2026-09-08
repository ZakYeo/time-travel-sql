import {
  POSTGRES_CONTEXT_PREFIX,
  postgresContextPayload,
} from '@time-travel-sql/sql-postgres';
import { HistoryError } from '@time-travel-sql/sdk';

/** The documented raw-query surface of a Prisma interactive transaction client. */
export interface PrismaContextTransaction {
  readonly $connect?: never;
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<number>;
}

/** Emit on the caller's transaction; no hidden wrapping, hooks, connection or commit ownership. */
export async function emitPrismaContext(
  transaction: PrismaContextTransaction,
  input: unknown,
): Promise<void> {
  if ('$connect' in transaction)
    throw new HistoryError(
      'INVALID_VALUE',
      'Pass the Prisma interactive transaction client, not the root client.',
    );
  const payload = postgresContextPayload(input);
  await transaction.$executeRaw`SELECT pg_catalog.pg_logical_emit_message(true, ${POSTGRES_CONTEXT_PREFIX}, ${payload}::text)`;
}
