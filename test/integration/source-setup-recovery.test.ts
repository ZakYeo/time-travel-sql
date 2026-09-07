import pg from 'pg';
import { expect, it } from 'vitest';
import {
  applyPostgresSetup,
  inspectPostgresSetup,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';
import { commitLossProxy } from '../../test-support/commit-loss-proxy.js';

const options = {
  publication: 'tts_setup',
  slot: 'tts_setup',
  ownershipToken: '0123456789abcdef0123456789abcdef',
  tables: [{ namespace: 'public', name: 'items' }],
};

it('cancels setup waiting on a table lock and rolls back source changes', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    const observer = new pg.Client(connection);
    await client.connect();
    await observer.connect();
    const controller = new AbortController();
    let settled: Promise<unknown> | undefined;
    try {
      await client.query('CREATE TABLE items(id integer PRIMARY KEY)');
      await client.query('BEGIN; LOCK TABLE items IN ACCESS EXCLUSIVE MODE');
      const settingUp = applyPostgresSetup(
        connection,
        options,
        'schema',
        controller.signal,
      );
      settled = settingUp.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
      await expect
        .poll(
          async () =>
            (
              await observer.query(
                "SELECT count(*)::int FROM pg_stat_activity WHERE application_name='time-travel-sql' AND wait_event_type='Lock'",
              )
            ).rows[0]?.count,
          { timeout: 4000 },
        )
        .toBe(1);
      controller.abort();
      expect(await settled).toMatchObject({
        ok: false,
        error: { code: 'CANCELLED' },
      });
      await client.query('ROLLBACK');
      await expect
        .poll(
          async () =>
            (
              await client.query(
                "SELECT count(*)::int FROM pg_stat_activity WHERE application_name='time-travel-sql'",
              )
            ).rows[0]?.count,
        )
        .toBe(0);
      expect(
        (
          await client.query(
            "SELECT relreplident FROM pg_class WHERE relname='items'",
          )
        ).rows,
      ).toEqual([{ relreplident: 'd' }]);
      expect(
        (await client.query('SELECT count(*)::int FROM pg_publication')).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      controller.abort();
      await settled;
      await observer.end();
      await client.end();
    }
  });
});

it('recovers setup ownership after the server commits but the transport discards its response', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    const proxy = await commitLossProxy(connection);
    try {
      await client.query('CREATE TABLE items(id integer PRIMARY KEY)');
      await expect(
        applyPostgresSetup(
          proxy.connection,
          options,
          'schema',
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
      expect(proxy.lostCommit()).toBe(true);
      const receipt = await inspectPostgresSetup(
        connection,
        options,
        'schema',
        new AbortController().signal,
      );
      expect(receipt.publication).toBe(options.publication);
      expect(
        (
          await client.query(
            "SELECT relreplident FROM pg_class WHERE relname='items'",
          )
        ).rows,
      ).toEqual([{ relreplident: 'f' }]);
      await expect(
        applyPostgresSetup(
          connection,
          options,
          'schema',
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
      expect(
        await inspectPostgresSetup(
          connection,
          options,
          'schema',
          new AbortController().signal,
        ),
      ).toEqual(receipt);
    } finally {
      await proxy.close();
      await client.end();
    }
  });
});
