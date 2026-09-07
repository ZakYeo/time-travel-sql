import pg from 'pg';
import { expect, it } from 'vitest';
import {
  cleanupPostgresPublication,
  planPostgresSetup,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';
import { commitLossProxy } from '../../test-support/commit-loss-proxy.js';
import {
  setupFixture,
  setupOptions,
} from '../../test-support/setup-fixture.js';

it('removes only the receipted publication and supports retry without changing table identity', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      const receipt = await setupFixture(client, connection);
      await client.query('CREATE PUBLICATION unrelated');
      await client.query(
        'CREATE ROLE cleanup_owner LOGIN REPLICATION; GRANT CREATE ON DATABASE postgres TO cleanup_owner; ALTER PUBLICATION tts_setup OWNER TO cleanup_owner',
      );
      const operator = { ...connection, user: 'cleanup_owner' };
      expect(
        await cleanupPostgresPublication(
          operator,
          receipt,
          new AbortController().signal,
        ),
      ).toBe('removed');
      expect(
        await cleanupPostgresPublication(
          operator,
          receipt,
          new AbortController().signal,
        ),
      ).toBe('absent');
      expect(
        (await client.query('SELECT pubname FROM pg_publication')).rows,
      ).toEqual([{ pubname: 'unrelated' }]);
      expect(
        (
          await client.query(
            "SELECT relreplident FROM pg_class WHERE relname='items'",
          )
        ).rows,
      ).toEqual([{ relreplident: 'f' }]);
    } finally {
      await client.end();
    }
  });
});

it('retries safely after cleanup commits but its response is lost', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    const proxy = await commitLossProxy(connection);
    try {
      const receipt = await setupFixture(client, connection);
      await expect(
        cleanupPostgresPublication(
          proxy.connection,
          receipt,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
      expect(proxy.lostCommit()).toBe(true);
      expect(
        await cleanupPostgresPublication(
          connection,
          receipt,
          new AbortController().signal,
        ),
      ).toBe('absent');
      expect(
        (await client.query('SELECT count(*)::int FROM pg_publication')).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await proxy.close();
      await client.end();
    }
  });
});

it('rejects another actual cluster even when its publication OID and marker match', async () => {
  await withPostgres(async (firstConnection) => {
    const first = new pg.Client(firstConnection);
    await first.connect();
    try {
      const receipt = await setupFixture(first, firstConnection);
      await withPostgres(async (secondConnection) => {
        const second = new pg.Client(secondConnection);
        await second.connect();
        try {
          const foreign = await setupFixture(second, secondConnection);
          expect(foreign.publicationOid).toBe(receipt.publicationOid);
          expect(foreign.systemId).not.toBe(receipt.systemId);
          await expect(
            cleanupPostgresPublication(
              secondConnection,
              receipt,
              new AbortController().signal,
            ),
          ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
          expect(
            (await second.query('SELECT pubname FROM pg_publication')).rows,
          ).toEqual([{ pubname: 'tts_setup' }]);
        } finally {
          await second.end();
        }
      });
    } finally {
      await first.end();
    }
  });
});

it.each(['marker', 'replacement', 'slot', 'database', 'timeline'])(
  'refuses cleanup for %s mismatch and preserves the publication',
  async (mismatch) => {
    await withPostgres(async (connection) => {
      const client = new pg.Client(connection);
      await client.connect();
      try {
        let receipt = await setupFixture(client, connection);
        if (mismatch === 'marker')
          await client.query("COMMENT ON PUBLICATION tts_setup IS 'foreign'");
        if (mismatch === 'replacement')
          await client.query(
            'DROP PUBLICATION tts_setup; CREATE PUBLICATION tts_setup',
          );
        if (mismatch === 'slot')
          await client.query(
            "SELECT pg_create_logical_replication_slot('tts_setup','pgoutput')",
          );
        if (mismatch === 'database') receipt = { ...receipt, databaseOid: '1' };
        if (mismatch === 'timeline') receipt = { ...receipt, timeline: '2' };
        const before = (
          await client.query(
            "SELECT oid::text, pubname, obj_description(oid,'pg_publication') AS marker FROM pg_publication",
          )
        ).rows;
        await expect(
          cleanupPostgresPublication(
            connection,
            receipt,
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
        expect(
          (
            await client.query(
              "SELECT oid::text, pubname, obj_description(oid,'pg_publication') AS marker FROM pg_publication",
            )
          ).rows,
        ).toEqual(before);
      } finally {
        await client.end();
      }
    });
  },
);

it.each(['marker', 'replacement', 'slot'])(
  'rechecks %s after waiting for the publication lock and rolls back a mismatched rename',
  async (change) => {
    await withPostgres(async (connection) => {
      const blocker = new pg.Client(connection);
      const observer = new pg.Client(connection);
      await blocker.connect();
      await observer.connect();
      const controller = new AbortController();
      let cleanup: Promise<unknown> | undefined;
      try {
        const receipt = await setupFixture(blocker, connection);
        await blocker.query('BEGIN');
        if (change === 'marker')
          await blocker.query("COMMENT ON PUBLICATION tts_setup IS 'foreign'");
        else if (change === 'replacement')
          await blocker.query(
            'DROP PUBLICATION tts_setup; CREATE PUBLICATION tts_setup',
          );
        else
          await blocker.query(
            `COMMENT ON PUBLICATION tts_setup IS '${planPostgresSetup(setupOptions).ownershipComment}'`,
          );
        cleanup = cleanupPostgresPublication(
          connection,
          receipt,
          controller.signal,
        ).then(
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
        if (change === 'slot')
          await observer.query(
            "SELECT pg_create_physical_replication_slot('tts_setup')",
          );
        await blocker.query('COMMIT');
        expect(await cleanup).toMatchObject({
          ok: false,
          error: { code: 'INVALID_HISTORY' },
        });
        const rows = (
          await observer.query(
            "SELECT pubname, obj_description(oid,'pg_publication') AS marker FROM pg_publication",
          )
        ).rows;
        expect(rows).toEqual([
          {
            pubname: 'tts_setup',
            marker: {
              marker: 'foreign',
              replacement: null,
              slot: planPostgresSetup(setupOptions).ownershipComment,
            }[change],
          },
        ]);
      } finally {
        controller.abort();
        await blocker.end();
        await cleanup;
        await observer.end();
      }
    });
  },
);
