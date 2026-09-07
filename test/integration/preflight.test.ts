import { LogicalReplicationService } from 'pg-logical-replication';
import pg from 'pg';
import { expect, it } from 'vitest';
import {
  inspectPostgresCapture,
  decodeLsn,
  ExactPgoutputPlugin,
} from '@time-travel-sql/source-postgres';
import { decodePosition } from '@time-travel-sql/sdk';
import { withPostgres } from '../../test-support/postgres.js';

it('checks exact publication and catalog scope without modifying source configuration', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    const options = {
      connection,
      publication: 'tts_preflight',
      schemaId: 'schema',
      tables: [{ namespace: 'public', name: 'items' }],
      signal: new AbortController().signal,
    };
    try {
      await client.query(`CREATE TABLE items (id integer PRIMARY KEY, note text);
        ALTER TABLE items REPLICA IDENTITY FULL;
        CREATE PUBLICATION tts_preflight FOR TABLE items`);
      const initial = await inspectPostgresCapture(options);
      expect(initial.schema.tables[0]?.primaryKey).toEqual(['id']);
      expect(initial.slot).toBeNull();
      expect(
        (
          await client.query(
            'SELECT count(*)::int AS count FROM pg_replication_slots',
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      for (const sql of [
        "ALTER PUBLICATION tts_preflight SET (publish='insert')",
        'ALTER PUBLICATION tts_preflight SET TABLE items WHERE (id > 0)',
        'ALTER PUBLICATION tts_preflight SET TABLE items (id)',
        'ALTER TABLE items REPLICA IDENTITY DEFAULT',
      ]) {
        await client.query(sql);
        await expect(inspectPostgresCapture(options)).rejects.toMatchObject({
          code: 'INVALID_SCHEMA',
        });
        await client.query(`ALTER TABLE items REPLICA IDENTITY FULL;
          ALTER PUBLICATION tts_preflight SET (publish='insert, update, delete, truncate');
          ALTER PUBLICATION tts_preflight SET TABLE items`);
      }
      await client.query(
        'CREATE TABLE unrelated (id integer PRIMARY KEY); ALTER PUBLICATION tts_preflight ADD TABLE unrelated',
      );
      await expect(inspectPostgresCapture(options)).rejects.toMatchObject({
        code: 'INVALID_SCHEMA',
      });
      await client.query(
        'ALTER PUBLICATION tts_preflight DROP TABLE unrelated',
      );
      const slot = (
        await client.query<{ lsn: string }>(
          "SELECT lsn::text FROM pg_create_logical_replication_slot('tts_preflight', 'pgoutput')",
        )
      ).rows[0];
      if (!slot) throw new Error('Missing slot');
      const resume = {
        systemId: initial.systemId,
        timeline: initial.timeline,
        slot: 'tts_preflight',
        databaseOid: initial.databaseOid,
        durablePosition: decodeLsn(slot.lsn),
        schema: initial.schema,
      };
      expect(
        (await inspectPostgresCapture({ ...options, resume })).slot
          ?.confirmedPosition,
      ).toBe(resume.durablePosition);
      for (const invalid of [
        { ...resume, databaseOid: '0' },
        { ...resume, systemId: '1' },
        { ...resume, timeline: '2' },
        { ...resume, slot: 'tts_missing' },
        { ...resume, durablePosition: decodePosition('0') },
        { ...resume, durablePosition: decodePosition('18446744073709551615') },
      ])
        await expect(
          inspectPostgresCapture({ ...options, resume: invalid }),
        ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
      const stream = new LogicalReplicationService(connection, {
        acknowledge: { auto: false, timeoutSeconds: 0 },
      });
      const started = Promise.withResolvers<void>();
      stream.on('start', () => started.resolve());
      stream.on('error', (error) => started.reject(error));
      const observed = started.promise.catch((error: unknown) => error);
      const subscription = stream
        .subscribe(
          new ExactPgoutputPlugin('tts_preflight'),
          'tts_preflight',
          slot.lsn,
        )
        .catch((error: unknown) => started.reject(error));
      try {
        const error = await observed;
        if (error !== undefined) throw error;
        await expect(
          inspectPostgresCapture({ ...options, resume }),
        ).rejects.toThrow('already active');
      } finally {
        await stream.stop();
        await subscription;
      }
      await client.query('ALTER TABLE items ALTER COLUMN note SET NOT NULL');
      await expect(
        inspectPostgresCapture({ ...options, resume }),
      ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
      expect(
        (
          await client.query(
            'SELECT count(*)::int AS count FROM pg_replication_slots',
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    } finally {
      await client.end();
    }
  });
});

it('reports missing replication/read permissions and cancellation without leaking connection details', async () => {
  await withPostgres(async (connection) => {
    const client = new pg.Client(connection);
    await client.connect();
    try {
      await client.query(`CREATE TABLE items (id integer PRIMARY KEY); ALTER TABLE items REPLICA IDENTITY FULL;
        CREATE PUBLICATION tts_preflight FOR TABLE items; CREATE ROLE restricted LOGIN`);
      const options = {
        connection: { ...connection, user: 'restricted' },
        publication: 'tts_preflight',
        schemaId: 'schema',
        tables: [{ namespace: 'public', name: 'items' }],
        signal: new AbortController().signal,
      };
      await expect(inspectPostgresCapture(options)).rejects.toMatchObject({
        code: 'STORAGE_FAILURE',
      });
      await client.query('ALTER ROLE restricted REPLICATION');
      await expect(inspectPostgresCapture(options)).rejects.toThrow('SELECT');
      await client.query('GRANT SELECT ON items TO restricted');
      await expect(inspectPostgresCapture(options)).resolves.toMatchObject({
        slot: null,
      });
      await client.query('REVOKE USAGE ON SCHEMA public FROM PUBLIC');
      await expect(inspectPostgresCapture(options)).rejects.toThrow('USAGE');
      await client.query('GRANT USAGE ON SCHEMA public TO restricted');
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        inspectPostgresCapture({ ...options, signal: cancelled.signal }),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      const controller = new AbortController();
      const pending = inspectPostgresCapture({
        ...options,
        signal: controller.signal,
      });
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      controller.abort();
      await rejection;
    } finally {
      await client.end();
    }
  });
});
