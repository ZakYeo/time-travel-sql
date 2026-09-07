import pg from 'pg';
import { expect, it } from 'vitest';
import {
  openPostgresStream,
  encodeLsn,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';
import { streamFixture } from '../../test-support/stream-fixture.js';
import { stalledStreamProxy } from '../../test-support/replication-proxy.js';

it('cancels stalled authentication on the actual streaming connection after preflight', async () => {
  await withPostgres(async (connection) => {
    const controller = new AbortController();
    const options = await streamFixture(connection, controller.signal);
    const proxy = await stalledStreamProxy(connection);
    try {
      const opening = openPostgresStream({
        ...options,
        connection: proxy.connection,
      });
      const rejected = expect(opening).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      await proxy.startup;
      controller.abort();
      await rejected;
      await proxy.disconnected;
    } finally {
      controller.abort();
      await proxy.close();
    }
  });
});

it('answers requested heartbeats using only durable progress despite newer server WAL', async () => {
  await withPostgres(async (connection) => {
    const options = await streamFixture(
      connection,
      new AbortController().signal,
    );
    const writer = new pg.Client(connection);
    await writer.connect();
    await writer.query("ALTER SYSTEM SET wal_sender_timeout='1s'");
    await writer.query('SELECT pg_reload_conf()');
    const stream = await openPostgresStream(options);
    try {
      await writer.query(
        'CREATE TABLE unrelated (id integer); INSERT INTO unrelated VALUES (1)',
      );
      const reply = async () =>
        (await writer.query('SELECT reply_time::text FROM pg_stat_replication'))
          .rows[0]?.reply_time ?? null;
      const previousReply = await reply();
      await expect
        .poll(
          async () => {
            const latestReply = await reply();
            return latestReply !== null && latestReply !== previousReply;
          },
          { timeout: 5000 },
        )
        .toBe(true);
      const result = (
        await writer.query(`SELECT confirmed_flush_lsn::text AS durable,
        pg_current_wal_lsn() > confirmed_flush_lsn AS newer FROM pg_replication_slots WHERE slot_name='tts_stream'`)
      ).rows[0];
      expect(result).toEqual({
        durable: encodeLsn(options.state.position),
        newer: true,
      });
      expect(stream.status().state).toBe('streaming');
    } finally {
      await stream.close();
      await writer.end();
    }
  });
});
