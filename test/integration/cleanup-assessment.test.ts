import pg from 'pg';
import { expect, it } from 'vitest';
import { HistoryState, decodeRecordingSchema } from '@time-travel-sql/sdk';
import {
  assessPostgresCleanup,
  cleanupPostgresPublication,
  encodeLsn,
  decodeLsn,
  openPostgresCaptureLease,
  openPostgresStream,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';
import { setupFixture } from '../../test-support/setup-fixture.js';

const signal = () => new AbortController().signal;

it('assesses publication-only cleanup and completed removal without mutating resources', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      const receipt = await setupFixture(client, connection);
      await client.query('CREATE PUBLICATION unrelated');
      const before = (
        await client.query(
          'SELECT oid, pubname FROM pg_publication ORDER BY oid',
        )
      ).rows;
      expect(
        await assessPostgresCleanup(connection, receipt, signal()),
      ).toMatchObject({
        publication: 'owned',
        slot: null,
        nextAction: 'cleanup-publication',
      });
      expect(
        (
          await client.query(
            'SELECT oid, pubname FROM pg_publication ORDER BY oid',
          )
        ).rows,
      ).toEqual(before);
      await cleanupPostgresPublication(connection, receipt, signal());
      expect(
        await assessPostgresCleanup(connection, receipt, signal()),
      ).toMatchObject({
        publication: 'absent',
        slot: null,
        nextAction: 'nothing-to-remove',
      });
    } finally {
      await client.end();
    }
  });
});

it('does not mistake a compatible independently created slot for deletion authority', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      const receipt = await setupFixture(client, connection);
      await client.query(
        "SELECT pg_create_logical_replication_slot($1, 'pgoutput')",
        [receipt.slot],
      );
      await client.query(
        "SELECT pg_create_logical_replication_slot('unrelated', 'pgoutput')",
      );
      const assessment = await assessPostgresCleanup(
        connection,
        receipt,
        signal(),
      );
      expect(assessment).toMatchObject({
        publication: 'owned',
        nextAction: 'review-slot-ownership',
        slot: {
          configuration: 'compatible',
          active: false,
          walStatus: 'reserved',
        },
      });
      const oracle = (
        await client.query<{ retained: string; unconfirmed: string }>(
          'SELECT pg_wal_lsn_diff($1::pg_lsn,restart_lsn)::text AS retained, pg_wal_lsn_diff($1::pg_lsn,confirmed_flush_lsn)::text AS unconfirmed FROM pg_replication_slots WHERE slot_name=$2',
          [encodeLsn(assessment.currentPosition), receipt.slot],
        )
      ).rows[0];
      expect(assessment.slot?.retainedWalBytes).toBe(oracle?.retained);
      expect(assessment.slot?.unconfirmedWalBytes).toBe(oracle?.unconfirmed);
      expect(
        (
          await client.query(
            'SELECT slot_name FROM pg_replication_slots ORDER BY slot_name',
          )
        ).rows,
      ).toEqual([{ slot_name: receipt.slot }, { slot_name: 'unrelated' }]);
    } finally {
      await client.end();
    }
  });
});

it('observes an active leased recorder without blocking or disrupting it', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      const receipt = await setupFixture(client, connection);
      const created = (
        await client.query<{ lsn: string }>(
          "SELECT lsn::text FROM pg_create_logical_replication_slot($1,'pgoutput')",
          [receipt.slot],
        )
      ).rows[0];
      if (!created) throw new Error('Missing created slot');
      const state = HistoryState.fromSnapshot(
        decodeRecordingSchema({
          sourceId: 'source',
          epochId: 'epoch',
          schema: receipt.schema,
        }),
        decodeLsn(created.lsn),
        [],
      );
      const lease = await openPostgresCaptureLease(
        connection,
        receipt,
        signal(),
      );
      try {
        const stream = await openPostgresStream({
          ...receipt,
          connection,
          lease,
          state,
          signal: signal(),
        });
        try {
          expect(
            await assessPostgresCleanup(connection, receipt, signal()),
          ).toMatchObject({
            nextAction: 'review-slot-ownership',
            slot: { active: true, configuration: 'compatible' },
          });
          await client.query('INSERT INTO items VALUES (1)');
          expect((await stream.next()).events).toHaveLength(1);
        } finally {
          await stream.close();
        }
      } finally {
        await lease.close();
      }
    } finally {
      await client.end();
    }
  });
});

it('reports a physical replacement without applying logical continuity rules', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      const receipt = await setupFixture(client, connection);
      await client.query('SELECT pg_create_physical_replication_slot($1)', [
        receipt.slot,
      ]);
      expect(
        await assessPostgresCleanup(connection, receipt, signal()),
      ).toMatchObject({
        nextAction: 'review-slot-ownership',
        slot: {
          configuration: 'different',
          restartPosition: null,
          confirmedPosition: null,
          retainedWalBytes: null,
          unconfirmedWalBytes: null,
        },
      });
      expect(
        (
          await client.query(
            'SELECT slot_type FROM pg_replication_slots WHERE slot_name=$1',
            [receipt.slot],
          )
        ).rows,
      ).toEqual([{ slot_type: 'physical' }]);
    } finally {
      await client.end();
    }
  });
});

it('reports lost WAL for explicit resource review instead of treating the slot as absent', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      const receipt = await setupFixture(client, connection);
      await client.query(
        "SELECT pg_create_logical_replication_slot($1, 'pgoutput')",
        [receipt.slot],
      );
      // This server is the fixture's private disposable cluster.
      await client.query("ALTER SYSTEM SET max_slot_wal_keep_size='0'");
      await client.query('SELECT pg_reload_conf()');
      await expect
        .poll(
          async () => (await client.query('SHOW max_slot_wal_keep_size')).rows,
        )
        .toEqual([{ max_slot_wal_keep_size: '0' }]);
      await client.query(
        "SELECT pg_logical_emit_message(false, 'tts_retention', repeat('x',20000000))",
      );
      await client.query('SELECT pg_switch_wal()');
      await client.query('CHECKPOINT');
      await expect
        .poll(
          async () =>
            (
              await client.query(
                'SELECT wal_status FROM pg_replication_slots WHERE slot_name=$1',
                [receipt.slot],
              )
            ).rows,
        )
        .toEqual([{ wal_status: 'lost' }]);
      expect(
        await assessPostgresCleanup(connection, receipt, signal()),
      ).toMatchObject({
        nextAction: 'review-slot-ownership',
        slot: { walStatus: 'lost', active: false },
      });
    } finally {
      await client.end();
    }
  });
});

it('reports changed publication ownership and rejects a different actual cluster', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      const receipt = await setupFixture(client, connection);
      await client.query("COMMENT ON PUBLICATION tts_setup IS 'changed'");
      expect(
        await assessPostgresCleanup(connection, receipt, signal()),
      ).toMatchObject({
        publication: 'different',
        nextAction: 'review-publication-ownership',
      });
      await withPostgres(async (other) => {
        await expect(
          assessPostgresCleanup(other, receipt, signal()),
        ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
      });
    } finally {
      await client.end();
    }
  });
});
