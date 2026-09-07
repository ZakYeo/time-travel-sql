import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { readSnapshot } from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';

it('does not authorize completion when cancellation arrives during connection shutdown', async () => {
  await withPostgres(async (connection) => {
    const admin = new pg.Client(connection);
    await admin.connect();
    const controller = new AbortController();
    const kinds: string[] = [];
    const originalEnd = pg.Client.prototype.end;
    try {
      await admin.query(
        'CREATE TABLE selected (id integer PRIMARY KEY); ALTER TABLE selected REPLICA IDENTITY FULL',
      );
      const close = vi
        .spyOn(pg.Client.prototype, 'end')
        .mockImplementation(function (this: pg.Client) {
          controller.abort(new Error('Cancelled during shutdown.'));
          return originalEnd.bind(this)();
        });
      try {
        const consume = async () => {
          for await (const part of readSnapshot({
            connection,
            slot: 'tts_shutdown',
            tables: [{ namespace: 'public', name: 'selected' }],
            signal: controller.signal,
          }))
            kinds.push(part.kind);
        };
        await expect(consume()).rejects.toMatchObject({
          errors: [
            expect.objectContaining({ message: 'Cancelled during shutdown.' }),
          ],
        });
        expect(kinds).toEqual(['begin']);
        expect(close).toHaveBeenCalledTimes(2);
      } finally {
        close.mockRestore();
      }
    } finally {
      await admin.end();
    }
  });
});

it('cancels snapshot staging without completion and closes both source connections', async () => {
  await withPostgres(async (connection) => {
    const admin = new pg.Client(connection);
    await admin.connect();
    const controller = new AbortController();
    const kinds: string[] = [];
    try {
      await admin.query(
        'CREATE TABLE selected (id integer PRIMARY KEY); ALTER TABLE selected REPLICA IDENTITY FULL; INSERT INTO selected SELECT generate_series(1,3)',
      );
      const consume = async () => {
        for await (const part of readSnapshot({
          connection,
          slot: 'tts_cancel',
          tables: [{ namespace: 'public', name: 'selected' }],
          signal: controller.signal,
          batchSize: 1,
        })) {
          kinds.push(part.kind);
          if (part.kind === 'rows')
            controller.abort(new Error('Cancelled by caller.'));
        }
      };
      await expect(consume()).rejects.toThrow(
        'Snapshot connection or cleanup failed',
      );
      expect(kinds).toEqual(['begin', 'rows']);
      const slots = await admin.query(
        "SELECT active FROM pg_replication_slots WHERE slot_name='tts_cancel'",
      );
      expect(slots.rows).toEqual([{ active: false }]);
      const readers = await admin.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='time-travel-sql'",
      );
      expect(readers.rows).toEqual([{ count: 0 }]);
    } finally {
      await admin.end();
    }
  });
});

it('rejects oversized snapshot values before delivering a row or completion', async () => {
  await withPostgres(async (connection) => {
    const admin = new pg.Client(connection);
    await admin.connect();
    try {
      await admin.query(
        "CREATE TABLE selected (id integer PRIMARY KEY, value text); ALTER TABLE selected REPLICA IDENTITY FULL; INSERT INTO selected VALUES (1, repeat('x',1048577))",
      );
      const kinds: string[] = [];
      const consume = async () => {
        for await (const part of readSnapshot({
          connection,
          slot: 'tts_oversize',
          tables: [{ namespace: 'public', name: 'selected' }],
          signal: AbortSignal.timeout(10000),
        }))
          kinds.push(part.kind);
      };
      await expect(consume()).rejects.toMatchObject({
        errors: [expect.objectContaining({ code: 'LIMIT_EXCEEDED' })],
      });
      expect(kinds).toEqual(['begin']);
    } finally {
      await admin.end();
    }
  });
});

it('rejects unsupported tables and never replaces an existing slot on retry', async () => {
  await withPostgres(async (connection) => {
    const admin = new pg.Client(connection);
    await admin.connect();
    try {
      await admin.query(
        'CREATE TABLE selected (id integer PRIMARY KEY, value integer[]); ALTER TABLE selected REPLICA IDENTITY FULL',
      );
      const consume = async () => {
        const kinds: string[] = [];
        for await (const part of readSnapshot({
          connection,
          slot: 'tts_unsupported',
          tables: [{ namespace: 'public', name: 'selected' }],
          signal: AbortSignal.timeout(10000),
        }))
          kinds.push(part.kind);
        return kinds;
      };
      await expect(consume()).rejects.toMatchObject({
        errors: [expect.objectContaining({ code: 'INVALID_SCHEMA' })],
      });
      await expect(consume()).rejects.toMatchObject({
        errors: [expect.objectContaining({ code: '42710' })],
      });
    } finally {
      await admin.end();
    }
  });
});
