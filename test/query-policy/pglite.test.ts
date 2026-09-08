import { Worker } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  policyFixture,
  cursorQuery,
} from '../../test-support/pglite-policy.js';

it('proves that username alone does not establish a non-superuser session boundary', async () => {
  const owner = await PGlite.create();
  let dump: Blob;
  try {
    await owner.exec('CREATE ROLE tts_reader NOSUPERUSER');
    dump = await owner.dumpDataDir('none');
  } finally {
    await owner.close();
  }
  const db = await PGlite.create({ loadDataDir: dump, username: 'tts_reader' });
  try {
    expect((await db.query('SELECT current_user, session_user')).rows).toEqual([
      { current_user: 'tts_reader', session_user: 'postgres' },
    ]);
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT current_user')).rows).toEqual([
      { current_user: 'postgres' },
    ]);
  } finally {
    await db.close();
  }
});

it('preserves useful exact SELECT results while rejecting statement and function escapes', async () => {
  const db = await policyFixture();
  try {
    const expected = [
      [
        '1',
        '1.234567890123456789',
        '{"n":9007199254740993}',
        '2026-01-01 12:13:14.123456',
      ],
    ];
    expect((await cursorQuery(db, 'SELECT * FROM orders')).rows).toEqual(
      expected,
    );
    expect(
      (
        await cursorQuery(
          db,
          'SELECT sum(a.amount+b.amount),count(*) FROM orders a JOIN orders b ON a.id=b.id',
        )
      ).rows,
    ).toEqual([['2.469135780246913578', '1']]);
    expect(
      (
        await cursorQuery(
          db,
          'WITH data AS (SELECT amount FROM orders) SELECT amount FROM data',
        )
      ).rows,
    ).toEqual([['1.234567890123456789']]);
    expect(
      (await cursorQuery(db, 'SELECT * FROM generate_series(1,100)')).rows,
    ).toEqual([['1'], ['2']]);
    const rejected = [
      'DELETE FROM orders',
      'INSERT INTO orders(id) VALUES(2)',
      'UPDATE orders SET amount=0',
      'TRUNCATE orders',
      'WITH removed AS (DELETE FROM orders RETURNING *) SELECT * FROM removed',
      'SELECT 1; DELETE FROM orders',
      'COMMIT',
      'ROLLBACK',
      'SET SESSION AUTHORIZATION postgres',
      'RESET ROLE',
      'CREATE TABLE bad(id int)',
      'CREATE TEMP TABLE bad(id int)',
      "COPY orders TO '/tmp/recording-leak'",
      'CREATE EXTENSION file_fdw',
      'SELECT * INTO bad FROM orders',
      'SELECT * FROM orders FOR UPDATE',
    ];
    const forbiddenFunctions = [
      "SELECT set_config('role','postgres',true)",
      "SELECT set_config('session_authorization','postgres',true)",
      "SELECT set_config('transaction_read_only','off',true)",
      "SELECT query_to_xml('SET SESSION AUTHORIZATION postgres',false,false,'')",
      "SELECT pg_read_file('/home/postgres/.pgpass')",
      "SELECT pg_read_binary_file('/etc/passwd')",
      'SELECT lo_create(0)',
      "SELECT pg_notify('unwanted','message')",
    ];
    const cases = [
      ...rejected.map((sql) => ({ sql, code: undefined })),
      ...forbiddenFunctions.map((sql) => ({ sql, code: '42501' })),
      { sql: 'SELECT public.attempt_write()', code: '25006' },
    ];
    for (const { sql, code } of cases) {
      if (code)
        await expect(cursorQuery(db, sql), sql).rejects.toMatchObject({ code });
      else
        await expect(cursorQuery(db, sql), sql).rejects.toBeInstanceOf(Error);
      expect((await cursorQuery(db, 'SELECT * FROM orders')).rows, sql).toEqual(
        expected,
      );
      expect(
        (await cursorQuery(db, 'SELECT current_user,session_user')).rows,
        sql,
      ).toEqual([['tts_reader', 'tts_reader']]);
    }
  } finally {
    await db.close();
  }
});

it('loads its bundled engine assets with fetch disabled', async () => {
  const fetch = vi.fn(() => {
    throw new Error('Network fetch forbidden in offline engine test');
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const db = await PGlite.create();
    try {
      expect((await db.query('SELECT 1 AS value')).rows).toEqual([
        { value: 1 },
      ]);
    } finally {
      await db.close();
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps the parent responsive and terminates an actively computing WASM query', async () => {
  const worker = new Worker(
    new URL('../../test-support/pglite-busy-worker.mjs', import.meta.url),
    { env: {} },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<{ ticks: number; exitCode: number }>(
      (resolve, reject) => {
        let phase: 'starting' | 'executing' | 'terminating' = 'starting';
        watchdog = setTimeout(
          () =>
            reject(
              new Error('Engine worker did not terminate within its budget'),
            ),
          20000,
        );
        worker.once('error', reject);
        worker.once('exit', () => {
          if (phase !== 'terminating')
            reject(new Error('Engine exited before cancellation'));
        });
        worker.on('message', (message: unknown) => {
          if (message !== 'executing' || phase !== 'starting') {
            reject(new Error('Unexpected worker state'));
            return;
          }
          phase = 'executing';
          let count = 0;
          const tick = () => {
            count++;
            if (count === 5) {
              phase = 'terminating';
              void worker
                .terminate()
                .then(
                  (exitCode) => resolve({ ticks: count, exitCode }),
                  reject,
                );
            } else timer = setTimeout(tick, 10);
          };
          timer = setTimeout(tick, 10);
        });
      },
    );
    expect(result).toEqual({ ticks: 5, exitCode: 1 });
  } finally {
    clearTimeout(timer);
    clearTimeout(watchdog);
    await worker.terminate();
  }
});
