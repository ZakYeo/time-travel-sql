import { createHash } from 'node:crypto';
import type pg from 'pg';
import { HistoryError } from '@time-travel-sql/sdk';
import { textRows } from './connection.js';

/** Cooperative, database-scoped locks. The owning connection must always close. */
export async function acquireCaptureLocks(
  client: pg.Client,
  names: { readonly publication: string; readonly slot: string },
): Promise<void> {
  const keys = [`publication:${names.publication}`, `slot:${names.slot}`]
    .map((name) =>
      createHash('sha256')
        .update(`time-travel-sql:capture:v1:${name}`)
        .digest()
        .readBigInt64BE()
        .toString(),
    )
    .sort();
  for (const key of keys) {
    const acquired = textRows(
      (
        await client.query({
          text: `SELECT pg_catalog.pg_try_advisory_lock('${key}'::bigint)::text`,
          rowMode: 'array',
        })
      ).rows,
    )[0]?.[0];
    if (acquired !== 'true')
      throw new HistoryError(
        'INVALID_HISTORY',
        'Another Time Travel SQL session owns the publication or slot lease.',
      );
  }
}
