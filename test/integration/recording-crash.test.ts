import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { expect, it } from 'vitest';
import {
  openLocalStore,
  createLocalReconstructor,
} from '@time-travel-sql/storage-local';
import {
  decodePosition,
  bootstrapBoundRecording,
  restoreRecordingHead,
  resumeRecording,
} from '@time-travel-sql/sdk';
import {
  openPostgresCaptureLease,
  planPostgresCapture,
  createPostgresResumeProvider,
  decodeLsn,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';
import { setupFixture } from '../../test-support/setup-fixture.js';
import { recordingCrashProcess } from '../../test-support/recording-crash-process.js';

it.each(['before-append', 'after-append', 'after-ack'] as const)(
  'recovers retained WAL after SIGKILL at %s without missing or duplicating commits',
  async (point) => {
    await withPostgres(async (connection) => {
      const root = await mkdtemp(join(tmpdir(), 'tts-crash-'));
      const path = join(root, 'history.sqlite');
      const client = new pg.Client(connection);
      await client.connect();
      let store = await openLocalStore({ path });
      const reconstructor = createLocalReconstructor({ path });
      let child: ReturnType<typeof recordingCrashProcess> | undefined;
      try {
        const receipt = await setupFixture(client, connection);
        await client.query('INSERT INTO items VALUES (0)');
        const lease = await openPostgresCaptureLease(
          connection,
          receipt,
          new AbortController().signal,
        );
        try {
          await bootstrapBoundRecording(
            planPostgresCapture({
              connection,
              lease,
              sourceId: 'source',
              epochId: 'epoch',
              signal: new AbortController().signal,
            }),
            store,
            {
              id: 'recording',
              name: 'Crash recovery',
              createdAt: '2026-09-07 00:00:00Z',
            },
          );
        } finally {
          await lease.close();
        }
        const baseline = (await store.info('recording')).headPosition;
        await store.close();
        child = recordingCrashProcess({ connection, path, point });
        await child.ready;
        await client.query('BEGIN');
        await client.query('UPDATE items SET id=1 WHERE id=0');
        await client.query('INSERT INTO items VALUES (2)');
        await client.query('COMMIT');
        const position = decodePosition(await child.barrier);
        const confirmed = async (): Promise<string> => {
          const result = await client.query<{ position: string }>(
            'SELECT confirmed_flush_lsn::text AS position FROM pg_replication_slots WHERE slot_name=$1',
            [receipt.slot],
          );
          const value = result.rows[0]?.position;
          if (!value) throw new Error('Retained slot is missing.');
          return decodeLsn(value);
        };
        if (point === 'after-ack') {
          await expect.poll(confirmed).toBe(position);
        } else {
          expect(await confirmed()).toBe(baseline);
        }
        expect(await child.kill()).toBe('SIGKILL');
        // Wait for PostgreSQL to observe socket death and release both source locks.
        await expect
          .poll(
            async () =>
              (
                await client.query(
                  "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory'",
                )
              ).rows,
          )
          .toEqual([{ count: 0 }]);
        await expect
          .poll(
            async () =>
              (
                await client.query(
                  'SELECT active FROM pg_replication_slots WHERE slot_name=$1',
                  [receipt.slot],
                )
              ).rows,
          )
          .toEqual([{ active: false }]);
        store = await openLocalStore({ path });
        expect(await store.info('recording')).toMatchObject({
          status: 'recording',
          transactionCount: point === 'before-append' ? 0 : 1,
          headPosition: point === 'before-append' ? baseline : position,
        });
        // A second commit lands while the recorder is down; source SQL is the oracle.
        await client.query('BEGIN');
        await client.query('DELETE FROM items WHERE id=1');
        await client.query('INSERT INTO items VALUES (3)');
        await client.query('COMMIT');
        const expected = (
          await client.query('SELECT id::text FROM items ORDER BY id')
        ).rows;
        const resumed = await resumeRecording(
          store,
          reconstructor,
          createPostgresResumeProvider(connection),
          'recording',
        );
        try {
          await expect
            .poll(async () => (await store.info('recording')).transactionCount)
            .toBe(2);
        } finally {
          await resumed.stop();
        }
        const restored = await restoreRecordingHead(
          store,
          reconstructor,
          'recording',
        );
        const table = restored.info.recording.schema.tables[0];
        if (!table) throw new Error('Recorded table is missing.');
        expect(
          restored.state.rows(table.id).map((row) => ({
            id: row[0]?.kind === 'scalar' ? row[0].value : undefined,
          })),
        ).toEqual(expected);
        expect(
          (await store.transaction('recording', position)).events,
        ).toHaveLength(2);
        expect(restored.info).toMatchObject({
          status: 'stopped',
          transactionCount: 2,
        });
        expect(
          (await client.query('SELECT slot_name FROM pg_replication_slots'))
            .rows,
        ).toEqual([{ slot_name: receipt.slot }]);
      } finally {
        await child?.kill();
        await reconstructor.close();
        await store.close();
        await client.end();
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
