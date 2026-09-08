import { decodeTransactionContext } from '@time-travel-sql/sdk';

export const POSTGRES_CONTEXT_PREFIX = 'tts.context.v1';

/** Shared wire payload for explicit PostgreSQL and ORM emission helpers. */
export function postgresContextPayload(input: unknown): string {
  return JSON.stringify(decodeTransactionContext(input));
}
