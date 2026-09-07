import pg from 'pg';
import { expect, it } from 'vitest';
import {
  applyPostgresSetup,
  planPostgresSetup,
  inspectPostgresCapture,
  inspectPostgresSetup,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';

const options = {
  publication: 'tts_setup',
  slot: 'tts_setup',
  ownershipToken: '0123456789abcdef0123456789abcdef',
  tables: [{ namespace: 'public', name: 'items' }],
};

it('applies exact publication setup atomically while excluding inherited children and leaving slot creation to bootstrap', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      await client.query(
        'CREATE TABLE items(id integer PRIMARY KEY); CREATE TABLE child() INHERITS(items)',
      );
      await client.query(
        'CREATE ROLE setup_owner LOGIN REPLICATION; GRANT CREATE ON DATABASE postgres TO setup_owner; ALTER TABLE items OWNER TO setup_owner',
      );
      const operatorConnection = { ...connection, user: 'setup_owner' };
      const plan = planPostgresSetup(options);
      expect(
        (await client.query('SELECT count(*)::int FROM pg_publication')).rows,
      ).toEqual([{ count: 0 }]);
      const receipt = await applyPostgresSetup(
        operatorConnection,
        options,
        'schema',
        new AbortController().signal,
      );
      expect(receipt.publicationOid).toMatch(/^[1-9][0-9]*$/);
      expect(
        (
          await client.query(
            "SELECT obj_description(oid, 'pg_publication') AS marker FROM pg_publication WHERE pubname='tts_setup'",
          )
        ).rows,
      ).toEqual([{ marker: plan.ownershipComment }]);
      expect(
        (
          await client.query(
            "SELECT relname, relreplident FROM pg_class WHERE relname IN ('items','child') ORDER BY relname",
          )
        ).rows,
      ).toEqual([
        { relname: 'child', relreplident: 'd' },
        { relname: 'items', relreplident: 'f' },
      ]);
      expect(
        (await client.query('SELECT count(*)::int FROM pg_replication_slots'))
          .rows,
      ).toEqual([{ count: 0 }]);
      const preflight = await inspectPostgresCapture({
        connection: operatorConnection,
        ...options,
        schemaId: 'schema',
        signal: new AbortController().signal,
      });
      expect(preflight.schema).toEqual(receipt.schema);
      expect(
        await inspectPostgresSetup(
          operatorConnection,
          options,
          'schema',
          new AbortController().signal,
        ),
      ).toEqual(receipt);
      await expect(
        inspectPostgresSetup(
          operatorConnection,
          { ...options, ownershipToken: 'a'.repeat(32) },
          'schema',
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
    } finally {
      await client.end();
    }
  });
});

it.each(['unsupported', 'publication', 'slot'])(
  'rolls back or rejects setup on %s conflicts',
  async (failure) => {
    await withPostgres(async (connection) => {
      const client = new pg.Client(connection);
      await client.connect();
      try {
        await client.query('CREATE TABLE items(id integer PRIMARY KEY)');
        if (failure === 'unsupported')
          await client.query('ALTER TABLE items ADD payload money');
        if (failure === 'publication')
          await client.query('CREATE PUBLICATION tts_setup');
        if (failure === 'slot')
          await client.query(
            "SELECT pg_create_logical_replication_slot('tts_setup', 'pgoutput')",
          );
        await expect(
          applyPostgresSetup(
            connection,
            options,
            'schema',
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({
          code:
            failure === 'unsupported' ? 'INVALID_SCHEMA' : 'INVALID_HISTORY',
        });
        expect(
          (
            await client.query(
              "SELECT relreplident FROM pg_class WHERE relname='items'",
            )
          ).rows,
        ).toEqual([{ relreplident: 'd' }]);
        expect(
          (await client.query('SELECT count(*)::int FROM pg_publication')).rows,
        ).toEqual([{ count: failure === 'publication' ? 1 : 0 }]);
        expect(
          (await client.query('SELECT count(*)::int FROM pg_replication_slots'))
            .rows,
        ).toEqual([{ count: failure === 'slot' ? 1 : 0 }]);
      } finally {
        await client.end();
      }
    });
  },
);
