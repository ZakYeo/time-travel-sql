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
  bootstrapBoundRecording,
  startRecording,
  restoreRecordingHead,
} from '@time-travel-sql/sdk';
import {
  openPostgresCaptureLease,
  planPostgresCapture,
  openPostgresStream,
  readPostgresCaptureBinding,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';
import { setupFixture } from '../../test-support/setup-fixture.js';

it('records, stops, reopens durable state and resumes retained resources through public APIs', async () => {
  await withPostgres(async (connection) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-session-'));
    const path = join(root, 'history.sqlite');
    const client = new pg.Client(connection);
    await client.connect();
    let store = await openLocalStore({ path });
    const reconstructor = createLocalReconstructor({ path });
    try {
      const receipt = await setupFixture(client, connection);
      const lease = await openPostgresCaptureLease(
        connection,
        receipt,
        new AbortController().signal,
      );
      try {
        const plan = planPostgresCapture({
          connection,
          lease,
          sourceId: 'source',
          epochId: 'epoch',
          signal: new AbortController().signal,
        });
        const info = await bootstrapBoundRecording(plan, store, {
          id: 'recording',
          name: 'Session',
          createdAt: '2026-09-07 00:00:00Z',
        });
        const { state } = await restoreRecordingHead(
          store,
          reconstructor,
          info.id,
        );
        const stream = await openPostgresStream({
          ...receipt,
          connection,
          lease,
          state,
          signal: new AbortController().signal,
        });
        const session = await startRecording(stream, store, info.id);
        try {
          await client.query('INSERT INTO items VALUES (1)');
          await client.query('INSERT INTO items VALUES (2)');
          await expect
            .poll(async () => (await store.info(info.id)).transactionCount)
            .toBe(2);
        } finally {
          await session.stop();
        }
        expect((await store.info(info.id)).status).toBe('stopped');
      } finally {
        await lease.close();
      }
      await store.close();
      store = await openLocalStore({ path });
      // Retained WAL can already be buffered when the recorder starts.
      await client.query('INSERT INTO items VALUES (3)');
      const info = await store.info('recording');
      const recovered = readPostgresCaptureBinding(
        info.recording,
        await store.captureBinding(info.id),
      );
      const resumedLease = await openPostgresCaptureLease(
        connection,
        recovered,
        new AbortController().signal,
      );
      try {
        const { state } = await restoreRecordingHead(
          store,
          reconstructor,
          info.id,
        );
        const stream = await openPostgresStream({
          ...recovered,
          connection,
          lease: resumedLease,
          state,
          signal: new AbortController().signal,
        });
        await expect
          .poll(() => stream.status().state)
          .toBe('waiting-for-durable');
        const session = await startRecording(stream, store, info.id);
        try {
          await expect
            .poll(async () => (await store.info(info.id)).transactionCount)
            .toBe(3);
        } finally {
          await session.stop();
        }
        expect((await store.info(info.id)).status).toBe('stopped');
        expect(
          (await client.query('SELECT slot_name FROM pg_replication_slots'))
            .rows,
        ).toEqual([{ slot_name: receipt.slot }]);
      } finally {
        await resumedLease.close();
      }
    } finally {
      await reconstructor.close();
      await store.close();
      await client.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
