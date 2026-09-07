import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { LogicalReplicationService } from 'pg-logical-replication';
import { expect, it, vi } from 'vitest';
import {
  openLocalStore,
  createLocalReconstructor,
} from '@time-travel-sql/storage-local';
import {
  bootstrapBoundRecording,
  restoreRecordingHead,
} from '@time-travel-sql/sdk';
import {
  openPostgresCaptureLease,
  planPostgresCapture,
  resumePostgresRecording,
  decodeLsn,
} from '@time-travel-sql/source-postgres';
import type { PostgresRecordingSession } from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';
import { setupFixture } from '../../test-support/setup-fixture.js';
import { postgresTransportProxy } from '../../test-support/postgres-transport-proxy.js';

it.each([
  'stream',
  'lease',
  'socket',
  'ack',
  'startup-timeout',
  'missing-slot',
] as const)(
  'reconnects retained capture safely after %s failure',
  async (fault) => {
    await withPostgres(async (connection) => {
      const root = await mkdtemp(join(tmpdir(), 'tts-reconnect-'));
      const path = join(root, 'history.sqlite');
      const client = new pg.Client(connection);
      await client.connect();
      const store = await openLocalStore({ path });
      const reconstructor = createLocalReconstructor({ path });
      const proxy = await postgresTransportProxy(
        connection,
        fault === 'startup-timeout',
      );
      let session: PostgresRecordingSession | undefined;
      let restoreAck = (): void => undefined;
      try {
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
              name: 'Reconnect',
              createdAt: '2026-09-07 00:00:00Z',
            },
          );
        } finally {
          await lease.close();
        }
        const baseline = (await store.info('recording')).headPosition;
        if (!baseline) throw new Error('Missing baseline');
        const current = resumePostgresRecording(
          store,
          reconstructor,
          proxy.connection,
          'recording',
          { initialDelayMs: 500 },
        );
        session = current;
        if (fault === 'startup-timeout') {
          await expect
            .poll(() => current.status().phase, { timeout: 9000 })
            .toBe('recording');
          expect(current.status().retries).toBe(1);
          expect(proxy.accepted()).toBeGreaterThan(1);
        } else {
          await expect.poll(() => current.status().phase).toBe('recording');
        }
        if (fault === 'ack') {
          const original = LogicalReplicationService.prototype.acknowledge;
          const spy = vi
            .spyOn(LogicalReplicationService.prototype, 'acknowledge')
            .mockImplementation(async function (
              this: LogicalReplicationService,
              ...args
            ) {
              if (BigInt(decodeLsn(args[0])) >= BigInt(baseline)) {
                restoreAck();
                throw Object.assign(
                  new Error('Injected socket write failure'),
                  { code: 'ECONNRESET' },
                );
              }
              return original.apply(this, args);
            });
          restoreAck = () => spy.mockRestore();
        }
        await client.query('INSERT INTO items VALUES (1)');
        await expect
          .poll(async () => (await store.info('recording')).transactionCount)
          .toBe(1);
        if (fault === 'stream' || fault === 'lease') {
          const query =
            fault === 'stream'
              ? 'SELECT active_pid AS pid FROM pg_replication_slots WHERE slot_name=$1'
              : "SELECT DISTINCT pid FROM pg_locks WHERE locktype='advisory'";
          const result = await client.query<{ pid: number }>(
            query,
            fault === 'stream' ? [receipt.slot] : [],
          );
          expect(result.rows).toHaveLength(1);
          await client.query('SELECT pg_terminate_backend($1)', [
            result.rows[0]?.pid,
          ]);
        } else if (fault === 'socket' || fault === 'missing-slot') proxy.drop();
        if (fault !== 'startup-timeout') {
          await expect
            .poll(() => current.status().phase)
            .toBe('waiting-to-retry');
          expect(current.status().lastFailure?.code).toBe('SOURCE_UNAVAILABLE');
        }
        if (fault === 'missing-slot') {
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
          await client.query('SELECT pg_drop_replication_slot($1)', [
            receipt.slot,
          ]);
          await expect(current.done).rejects.toMatchObject({
            code: 'INVALID_HISTORY',
          });
          expect(current.status()).toMatchObject({
            phase: 'failed',
            retries: 1,
          });
          expect((await store.info('recording')).transactionCount).toBe(1);
          expect(
            (await client.query('SELECT slot_name FROM pg_replication_slots'))
              .rows,
          ).toEqual([]);
        } else {
          await client.query('INSERT INTO items VALUES (2)');
          await expect
            .poll(async () => (await store.info('recording')).transactionCount)
            .toBe(2);
          await current.stop();
          expect(current.status()).toMatchObject({
            phase: 'stopped',
            retries: 1,
          });
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
        }
      } finally {
        restoreAck();
        await session?.stop().catch(() => {
          /* Failure cases assert completion above. */
        });
        await proxy.close();
        await reconstructor.close();
        await store.close();
        await client.end();
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
