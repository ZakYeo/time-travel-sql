import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { expect, it } from 'vitest';
import { openLocalStore } from '@time-travel-sql/storage-local';
import {
  decodeRecordingMetadata,
  bootstrapBoundRecording,
} from '@time-travel-sql/sdk';
import {
  createPostgresCaptureBinding,
  readPostgresCaptureBinding,
  openPostgresCaptureLease,
  openPostgresBaseline,
  planPostgresCapture,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';
import {
  setupFixture,
  setupOptions,
} from '../../test-support/setup-fixture.js';

it('uses the public capture plan to persist binding before the actual slot-creating open', async () => {
  await withPostgres(async (connection) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-planned-capture-'));
    const path = join(root, 'history.sqlite');
    const client = new pg.Client(connection);
    await client.connect();
    const store = await openLocalStore({ path });
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
        let verified = false;
        const info = await bootstrapBoundRecording(
          {
            ...plan,
            async openBaseline() {
              const independent = await openLocalStore({ path });
              try {
                expect(await independent.captureBinding('planned')).toEqual(
                  plan.binding,
                );
                expect((await independent.info('planned')).status).toBe(
                  'bootstrapping',
                );
              } finally {
                await independent.close();
              }
              expect(
                (
                  await client.query(
                    'SELECT slot_name FROM pg_replication_slots',
                  )
                ).rows,
              ).toEqual([]);
              verified = true;
              return plan.openBaseline();
            },
          },
          store,
          {
            id: 'planned',
            name: 'Planned capture',
            createdAt: '2026-09-07 00:00:00Z',
          },
        );
        expect(verified).toBe(true);
        expect(info).toMatchObject({
          status: 'recording',
          baselineRowCount: 0,
        });
        expect(
          (await client.query('SELECT slot_name FROM pg_replication_slots'))
            .rows,
        ).toEqual([{ slot_name: receipt.slot }]);
      } finally {
        await lease.close();
      }
    } finally {
      await store.close();
      await client.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('reopens persisted source metadata before acquiring a lease and publishing the bound baseline', async () => {
  await withPostgres(async (connection) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-source-binding-'));
    const path = join(root, 'history.sqlite');
    const client = new pg.Client(connection);
    await client.connect();
    let store = await openLocalStore({ path });
    try {
      const receipt = await setupFixture(client, connection);
      const metadata = decodeRecordingMetadata({
        id: 'recording',
        name: 'Bound source',
        createdAt: '2026-09-07 00:00:00Z',
        recording: {
          sourceId: 'source',
          epochId: 'epoch',
          schema: receipt.schema,
        },
      });
      await store.create(metadata);
      await store.bindCapture(
        metadata.id,
        createPostgresCaptureBinding(metadata.recording, receipt),
      );
      await store.close();
      store = await openLocalStore({ path });
      const info = await store.info(metadata.id);
      const recovered = readPostgresCaptureBinding(
        info.recording,
        await store.captureBinding(metadata.id),
      );
      expect(recovered).toEqual(receipt);
      expect(
        (await client.query('SELECT slot_name FROM pg_replication_slots')).rows,
      ).toEqual([]);
      const lease = await openPostgresCaptureLease(
        connection,
        recovered,
        new AbortController().signal,
      );
      try {
        const baseline = await openPostgresBaseline({
          connection,
          slot: recovered.slot,
          tables: setupOptions.tables,
          sourceId: info.recording.sourceId,
          epochId: info.recording.epochId,
          schemaId: info.recording.schema.id,
          signal: new AbortController().signal,
          lease,
        });
        try {
          while (true) {
            const rows = await baseline.next();
            if (rows === null) break;
            await store.stageBaseline(metadata.id, rows);
          }
        } finally {
          await baseline.close();
        }
        await store.publishBaseline(metadata.id, baseline.position);
        await store.setStatus(metadata.id, 'stopped');
      } finally {
        await lease.close();
      }
      await store.close();
      store = await openLocalStore({ path });
      expect((await store.info(metadata.id)).status).toBe('stopped');
      expect(
        readPostgresCaptureBinding(
          info.recording,
          await store.captureBinding(metadata.id),
        ),
      ).toEqual(receipt);
      const resumed = await openPostgresCaptureLease(
        connection,
        recovered,
        new AbortController().signal,
      );
      await resumed.close();
      expect(
        (await client.query('SELECT slot_name FROM pg_replication_slots')).rows,
      ).toEqual([{ slot_name: receipt.slot }]);
    } finally {
      await store.close();
      await client.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
