import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { expect, it } from 'vitest';
import {
  bootstrapBoundRecording,
  restoreRecordingHead,
} from '@time-travel-sql/sdk';
import {
  openLocalStore,
  createLocalReconstructor,
} from '@time-travel-sql/storage-local';
import {
  openPostgresCaptureLease,
  planPostgresCapture,
  resumePostgresRecording,
} from '@time-travel-sql/source-postgres';
import { withComposePostgres } from '../../test-support/postgres-compose.js';
import { setupFixture } from '../../test-support/setup-fixture.js';

it('captures a committed transaction from a fresh Compose PostgreSQL instance', async () => {
  await withComposePostgres(async (connection) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-compose-recording-'));
    const path = join(root, 'history.sqlite');
    const cleanup: Array<() => Promise<void>> = [
      () => rm(root, { recursive: true, force: true }),
    ];
    const failures: unknown[] = [];
    try {
      const client = new pg.Client({
        ...connection,
        connectionTimeoutMillis: 5000,
        query_timeout: 10000,
        statement_timeout: 10000,
      });
      cleanup.unshift(() => client.end());
      await client.connect();
      const store = await openLocalStore({ path });
      cleanup.unshift(() => store.close());
      const reconstructor = createLocalReconstructor({ path });
      cleanup.unshift(() => reconstructor.close());
      expect(
        (
          await client.query(
            "SELECT current_setting('server_version_num') AS version, current_setting('wal_level') AS wal",
          )
        ).rows,
      ).toEqual([{ version: '160015', wal: 'logical' }]);
      const receipt = await setupFixture(client, connection);
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
            name: 'Compose capture',
            createdAt: '2026-09-07 00:00:00Z',
          },
        );
      } finally {
        await lease.close();
      }
      const session = resumePostgresRecording(
        store,
        reconstructor,
        connection,
        'recording',
      );
      try {
        await expect.poll(() => session.status().phase).toBe('recording');
        await client.query('INSERT INTO items VALUES (1), (2)');
        await expect
          .poll(async () => (await store.info('recording')).transactionCount)
          .toBe(1);
      } finally {
        await session.stop();
      }
      const restored = await restoreRecordingHead(
        store,
        reconstructor,
        'recording',
      );
      const table = restored.info.recording.schema.tables[0];
      if (!table) throw new Error('Missing recorded table');
      expect(
        restored.state.rows(table.id).map((row) => ({
          id: row[0]?.kind === 'scalar' ? row[0].value : undefined,
        })),
      ).toEqual(
        (await client.query('SELECT id::text FROM items ORDER BY id')).rows,
      );
      expect(
        (await client.query('SELECT slot_name FROM pg_replication_slots')).rows,
      ).toEqual([{ slot_name: receipt.slot }]);
    } catch (error) {
      failures.push(error);
    }
    for (const close of cleanup) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'Compose capture cleanup failed.');
  });
});
