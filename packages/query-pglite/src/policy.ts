import type { PGlite } from '@electric-sql/pglite';
import { HistoryError, QueryResultBuffer } from '@time-travel-sql/sdk';
import type { QueryRequest, QueryResult } from '@time-travel-sql/sdk';

/** Only pristine catalog functions are admitted. No source functions/extensions
 * are installed. Operator implementations support normal expressions and joins.
 */
export async function restrictEngine(db: PGlite): Promise<void> {
  const functions = await db.query<{ signature: string }>(
    `
    SELECT DISTINCT p.oid::regprocedure::text AS signature
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='pg_catalog' AND (
      p.oid IN (SELECT oprcode FROM pg_catalog.pg_operator WHERE oprcode<>0)
      OR p.proname = ANY($1::text[]))`,
    [
      [
        'count',
        'sum',
        'avg',
        'min',
        'max',
        'lower',
        'upper',
        'length',
        'abs',
        'round',
        'generate_series',
        'int2',
        'int4',
        'int8',
        'numeric',
        'text',
        'varchar',
        'date',
        'timestamp',
        'timestamptz',
        'json',
        'jsonb',
        'bytea',
        'bool',
        'coalesce',
        'substring',
        'date_trunc',
        'date_part',
        'now',
        'transaction_timestamp',
      ],
    ],
  );
  const types = await db.query<{ oid: string }>(
    'SELECT oid::text FROM pg_catalog.pg_type',
  );
  await db.exec(
    'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_catalog FROM PUBLIC',
  );
  for (const { signature } of functions.rows)
    await db.exec(`GRANT EXECUTE ON FUNCTION ${signature} TO tts_reader`);
  for (const { oid } of types.rows)
    db.parsers[oid] = (text: string): string => text;
  await db.exec('SET SESSION AUTHORIZATION tts_reader');
}

export async function executeReadOnly(
  db: PGlite,
  request: QueryRequest,
): Promise<QueryResult> {
  await db.exec('BEGIN READ ONLY');
  // The single-statement extended protocol and DECLARE grammar enforce the
  // statement boundary; user SQL never enters exec's multi-statement protocol.
  await db.query(`DECLARE tts_result NO SCROLL CURSOR FOR ${request.sql}`);
  const first = await db.query<unknown[]>(
    'FETCH FORWARD 1 FROM tts_result',
    [],
    { rowMode: 'array' },
  );
  const buffer = new QueryResultBuffer(
    first.fields.map((field) => ({
      name: field.name,
      typeOid: field.dataTypeID,
    })),
    request.limits,
  );
  for (const row of first.rows) buffer.append(row);
  let rows = first.rows;
  while (rows.length) {
    rows = (
      await db.query<unknown[]>('FETCH FORWARD 1 FROM tts_result', [], {
        rowMode: 'array',
      })
    ).rows;
    for (const row of rows) buffer.append(row);
  }
  await db.exec('ROLLBACK');
  return buffer.finish();
}

/** Safe public error text never includes user SQL, row values or engine detail. */
export function queryFailure(error: unknown): HistoryError {
  if (error instanceof HistoryError) return error;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(error.code)
  ) {
    if (/^(53|54)/.test(error.code))
      return new HistoryError(
        'LIMIT_EXCEEDED',
        'Historical SQL exceeded an engine resource limit.',
      );
    return new HistoryError(
      'QUERY_REJECTED',
      error.code === '42501'
        ? 'Historical SQL cannot read an unavailable column or use a restricted capability.'
        : 'Historical SQL is unsupported or could not be evaluated.',
    );
  }
  return new HistoryError(
    'QUERY_FAILURE',
    'The disposable historical query engine failed.',
  );
}
