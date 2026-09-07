import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalStore } from '@time-travel-sql/storage-local';
import {
  recordNextCommit,
  decodeRecordingMetadata,
} from '@time-travel-sql/sdk';
import pg from 'pg';
import { expect, it } from 'vitest';
import {
  openPostgresStream,
  encodeLsn,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';
import { streamFixture } from '../../test-support/stream-fixture.js';

it('holds durable progress, resumes unconfirmed delivery, and cancels an idle read', async () => {
  await withPostgres(async (connection) => {
    const controller = new AbortController();
    const options = await streamFixture(connection, controller.signal);
    const writer = new pg.Client(connection);
    await writer.connect();
    const root = await mkdtemp(join(tmpdir(), 'tts-stream-history-'));
    const path = join(root, 'history.sqlite');
    let store = await openLocalStore({ path });
    await store.create(
      decodeRecordingMetadata({
        id: 'recording',
        name: 'Stream history',
        createdAt: '2026-01-01 00:00:00Z',
        recording: options.state.recording,
      }),
    );
    await store.stageBaseline(
      'recording',
      options.state.recording.schema.tables.flatMap((table) =>
        options.state.rows(table.id).map((row) => ({ tableId: table.id, row })),
      ),
    );
    await store.publishBaseline('recording', options.state.position);
    let stream = await openPostgresStream(options);
    const flush = async () =>
      (
        await writer.query(
          'SELECT confirmed_flush_lsn::text AS position FROM pg_replication_slots WHERE slot_name=$1',
          ['tts_stream'],
        )
      ).rows[0]?.position;
    try {
      await writer.query('UPDATE items SET value=1');
      await writer.query('UPDATE items SET value=2');
      await writer.query('UPDATE items SET value=3');
      const first = await stream.next();
      expect(first.events[0]).toMatchObject({
        after: [{ value: '1' }, { value: '1' }],
      });
      expect(stream.status()).toMatchObject({
        state: 'waiting-for-durable',
        durablePosition: options.state.position,
        receivedPosition: first.position,
      });
      expect(await flush()).toBe(encodeLsn(options.state.position));
      await expect(stream.next()).rejects.toThrow('Only one');
      await store.append('recording', first);
      const durable = options.state.apply(first);
      await stream.acknowledge(first.position);
      await expect.poll(flush).toBe(encodeLsn(first.position));
      const unconfirmed = await stream.next();
      await stream.close();
      expect(await flush()).toBe(encodeLsn(first.position));
      await store.close();
      store = await openLocalStore({ path });
      expect(await store.transaction('recording', first.position)).toEqual(
        first,
      );
      stream = await openPostgresStream({ ...options, state: durable });
      const redelivered = await recordNextCommit(stream, store, 'recording');
      expect(redelivered).toEqual(unconfirmed);
      const third = await recordNextCommit(stream, store, 'recording');
      expect(third.events[0]).toMatchObject({
        after: [{ value: '1' }, { value: '3' }],
      });
      expect((await store.info('recording')).transactionCount).toBe(3);
      const pending = stream.next();
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      controller.abort();
      await rejected;
      await stream.close();
      expect(stream.status()).toMatchObject({
        state: 'closed',
        durablePosition: third.position,
      });
      expect(
        (
          await writer.query(
            'SELECT active FROM pg_replication_slots WHERE slot_name=$1',
            ['tts_stream'],
          )
        ).rows,
      ).toEqual([{ active: false }]);
    } finally {
      await stream.close();
      await writer.end();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('times out unconfirmed work without advancing the retained slot', async () => {
  await withPostgres(async (connection) => {
    const options = await streamFixture(
      connection,
      new AbortController().signal,
    );
    const writer = new pg.Client(connection);
    await writer.connect();
    const stream = await openPostgresStream({ ...options, timeoutMs: 1000 });
    try {
      await writer.query('UPDATE items SET value=1');
      await stream.next();
      await expect
        .poll(() => stream.status().state, { timeout: 5000 })
        .toBe('failed');
      await expect(stream.next()).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
      await stream.close();
      expect(
        (
          await writer.query(
            'SELECT confirmed_flush_lsn::text AS position FROM pg_replication_slots WHERE slot_name=$1',
            ['tts_stream'],
          )
        ).rows[0]?.position,
      ).toBe(encodeLsn(options.state.position));
    } finally {
      await stream.close();
      await writer.end();
    }
  });
});
