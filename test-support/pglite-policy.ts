import { PGlite } from '@electric-sql/pglite';

/** Engine feasibility fixture, not the production historical query adapter.
 * Only trusted fixed DDL/catalog output enters setup; user SQL enters query().
 */
export async function policyFixture(): Promise<PGlite> {
  const db = await PGlite.create();
  try {
    await db.exec(`
      CREATE ROLE tts_reader NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      CREATE TABLE public.orders(id int PRIMARY KEY, amount numeric, details json, at timestamp);
      INSERT INTO public.orders VALUES(1,1.234567890123456789,'{"n":9007199254740993}','2026-01-01 12:13:14.123456');
      REVOKE ALL ON DATABASE postgres FROM PUBLIC;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO tts_reader;
      GRANT SELECT ON public.orders TO tts_reader;
      CREATE TABLE public.lossy(id int PRIMARY KEY, available text, secret text);
      INSERT INTO public.lossy VALUES(1,'one',NULL),(2,'two','known');
      GRANT SELECT(id,available) ON public.lossy TO tts_reader;
      CREATE FUNCTION public.attempt_write() RETURNS int LANGUAGE sql
      VOLATILE SECURITY DEFINER AS 'UPDATE public.orders SET amount=0 RETURNING id';
    `);
    const functions = await db.query<{ signature: string }>(
      `
      SELECT DISTINCT p.oid::regprocedure::text AS signature
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='pg_catalog' AND (
        p.oid IN (SELECT oprcode FROM pg_catalog.pg_operator WHERE oprcode<>0)
        OR p.proname = ANY($1::text[]))
    `,
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
          'int8',
        ],
      ],
    );
    await db.exec(
      'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_catalog FROM PUBLIC',
    );
    for (const { signature } of functions.rows) {
      // Signatures come solely from the pristine bundled engine catalog.
      await db.exec(`GRANT EXECUTE ON FUNCTION ${signature} TO tts_reader`);
    }
    await db.exec('SET SESSION AUTHORIZATION tts_reader');
    return db;
  } catch (error) {
    await db.close().catch((cleanup: unknown) => {
      throw new AggregateError(
        [error, cleanup],
        'Policy setup and cleanup failed.',
      );
    });
    throw error;
  }
}

const exactText = (text: string): string => text;
const parsers = {
  20: exactText,
  23: exactText,
  1700: exactText,
  114: exactText,
  3802: exactText,
  1114: exactText,
  1184: exactText,
};

/** DECLARE's grammar and the extended protocol constrain SQL without a regex.
 * Fetch bounds returned rows only; this does not yet bound cells, bytes or work.
 */
export async function cursorQuery(db: PGlite, sql: string) {
  await db.exec('BEGIN READ ONLY');
  let failed = false;
  let primary: unknown;
  try {
    await db.query(`DECLARE tts_result NO SCROLL CURSOR FOR ${sql}`);
    return await db.query<unknown[]>('FETCH FORWARD 2 FROM tts_result', [], {
      rowMode: 'array',
      parsers,
    });
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    await db.exec('ROLLBACK').catch((cleanup: unknown) => {
      if (failed)
        throw new AggregateError(
          [primary, cleanup],
          'Policy query and rollback failed.',
        );
      throw cleanup;
    });
  }
}
