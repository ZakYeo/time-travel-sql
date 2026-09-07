import pg from 'pg';
import { LogicalReplicationService } from 'pg-logical-replication';
import { expect, it } from 'vitest';
import {
  readSnapshot,
  ExactPgoutputPlugin,
  PgoutputFrame,
  encodeLsn,
} from '@time-travel-sql/source-postgres';
import type { Position } from '@time-travel-sql/sdk';
import { withPostgres } from '../../test-support/postgres.js';

it('coordinates a multi-table exported snapshot with concurrent committed pgoutput writes', async () => {
  await withPostgres(async (connection) => {
    const writer = new pg.Client(connection);
    await writer.connect();
    const service = new LogicalReplicationService(connection, {
      acknowledge: { auto: false, timeoutSeconds: 0 },
      flowControl: { enabled: true },
    });
    const frames: PgoutputFrame[] = [];
    let position: Position | undefined;
    const baseline: unknown[] = [];
    const deadline = AbortSignal.timeout(15000);
    const streamResult = Promise.withResolvers<void>();
    // Keep the rejection observed even when an earlier assertion fails.
    const observed = streamResult.promise.catch((error: unknown) => error);
    let commits = 0;
    service.on('error', (error) => streamResult.reject(error));
    service.on('data', (_lsn: string, input: unknown) => {
      if (!(input instanceof PgoutputFrame))
        throw new Error('Invalid plugin frame');
      if (input.result.kind === 'error') {
        streamResult.reject(input.result.error);
        return;
      }
      frames.push(input);
      if (input.result.message.tag === 'commit' && ++commits === 2)
        streamResult.resolve();
    });
    const timeout = () =>
      streamResult.reject(new Error('Timed out waiting for source commits.'));
    deadline.addEventListener('abort', timeout, { once: true });
    let subscription: Promise<unknown> | undefined;
    try {
      await writer.query(`CREATE TABLE orders (id bigint PRIMARY KEY, amount numeric, payload jsonb, at timestamp, bytes bytea);
        CREATE TABLE inventory (sku text PRIMARY KEY, quantity integer);
        ALTER TABLE orders REPLICA IDENTITY FULL; ALTER TABLE inventory REPLICA IDENTITY FULL;
        INSERT INTO orders VALUES (9007199254740993, 12345678901234567890.123456789, '{"n":9007199254740993}', '2026-01-02 03:04:05.123456', decode('00ff', 'hex'));
        INSERT INTO inventory VALUES ('sku', 9);
        CREATE PUBLICATION tts_handoff FOR TABLE orders, inventory`);
      for await (const part of readSnapshot({
        connection,
        slot: 'tts_handoff',
        tables: [
          { namespace: 'public', name: 'orders' },
          { namespace: 'public', name: 'inventory' },
        ],
        signal: deadline,
        batchSize: 1,
      })) {
        if (part.kind === 'begin') {
          position = part.position;
          expect(
            part.tables.map(
              (table) =>
                table.columns.filter((column) => column.keyOrder !== null)
                  .length,
            ),
          ).toEqual([1, 1]);
          await writer.query(`BEGIN; UPDATE orders SET amount=98765432109876543210.987654321;
            UPDATE inventory SET quantity=8; SAVEPOINT undone; UPDATE inventory SET quantity=-10;
            ROLLBACK TO SAVEPOINT undone; COMMIT;
            BEGIN; DELETE FROM orders; ROLLBACK;
            BEGIN; UPDATE orders SET id=9007199254740994; UPDATE inventory SET quantity=7; COMMIT;`);
        }
        if (part.kind === 'rows') baseline.push(...part.rows);
      }
      expect(baseline).toEqual([
        [
          '9007199254740993',
          '12345678901234567890.123456789',
          '{"n": 9007199254740993}',
          '2026-01-02 03:04:05.123456',
          '\\x00ff',
        ],
        ['sku', '9'],
      ]);
      if (!position) throw new Error('Snapshot boundary missing.');
      subscription = service
        .subscribe(
          new ExactPgoutputPlugin('tts_handoff'),
          'tts_handoff',
          encodeLsn(position),
        )
        .catch((error: unknown) => {
          streamResult.reject(error);
        });
      const failure: unknown = await observed;
      if (failure !== undefined) throw failure;
      const changes = frames.flatMap((frame) =>
        frame.result.kind === 'message' &&
        ['insert', 'update', 'delete'].includes(frame.result.message.tag)
          ? [frame.result.message]
          : [],
      );
      expect(changes.map((message) => message.tag)).toEqual([
        'update',
        'update',
        'update',
        'update',
      ]);
      const first = changes[0];
      if (first?.tag !== 'update') throw new Error('Expected order update.');
      expect(first.old?.amount).toBe('12345678901234567890.123456789');
      expect(first.new.amount).toBe('98765432109876543210.987654321');
      expect(first.new.payload).toBe('{"n": 9007199254740993}');
      expect(first.new.at).toBe('2026-01-02 03:04:05.123456');
      expect(first.new.bytes).toBe('\\x00ff');
      expect(commits).toBe(2);
      // Observation alone must not advance the slot's durable acknowledgement.
      const progress = await writer.query(
        'SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name=$1',
        ['tts_handoff'],
      );
      expect(progress.rows[0]?.confirmed_flush_lsn).toBe(encodeLsn(position));
    } finally {
      deadline.removeEventListener('abort', timeout);
      await service.stop();
      await subscription;
      await writer.end();
    }
  });
});
