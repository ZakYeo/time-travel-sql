import pg from 'pg';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withPostgres } from '../../test-support/postgres.js';
import {
  sourceConfig,
  sourceCli,
} from '../../test-support/source-cli-fixture.js';

it('plans, explicitly sets up and inspects a native PostgreSQL source through the real CLI', async () => {
  await withPostgres(async (connection) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-source-cli-'));
    const client = new pg.Client(connection);
    await client.connect();
    const secret = 'source-secret-never-in-arguments-or-output';
    const env = {
      TTS_TEST_SOURCE_PASSWORD: secret,
      PGHOST: 'wrong.invalid',
      PGPORT: '1',
      PGUSER: 'wrong',
      PGDATABASE: 'wrong',
      PGPASSWORD: 'ambient-ignored',
      PGSSLMODE: 'require',
      PGREPLICATION: 'true',
      PGCLIENT_ENCODING: 'invalid-encoding',
      PGSSLNEGOTIATION: 'invalid-negotiation',
    };
    try {
      await client.query('CREATE TABLE items(id integer PRIMARY KEY)');
      await writeFile(
        join(root, 'source.json'),
        JSON.stringify(sourceConfig(connection)),
      );
      const planned = await sourceCli(root, 'source-plan');
      expect(planned.code).toBe(0);
      expect(
        (await client.query('SELECT count(*)::int AS n FROM pg_publication'))
          .rows,
      ).toEqual([{ n: 0 }]);
      expect((await sourceCli(root, 'source-doctor', env)).code).toBe(1);
      const applied = await sourceCli(root, 'source-setup', env);
      expect(applied.code, applied.stderr).toBe(0);
      const receipt = JSON.parse(applied.stdout).data;
      expect(receipt).toMatchObject({
        publication: 'tts_cli',
        slot: 'tts_cli',
        schema: { tables: [{ name: 'items' }] },
      });
      const inspected = await sourceCli(root, 'source-inspect', env);
      expect(inspected.code).toBe(0);
      expect(JSON.parse(inspected.stdout).data).toEqual(receipt);
      await writeFile(
        join(root, 'source.json'),
        JSON.stringify({
          ...sourceConfig(connection),
          ownershipToken: 'ffffffffffffffffffffffffffffffff',
        }),
      );
      expect((await sourceCli(root, 'source-doctor', env)).code).toBe(1);
      await writeFile(
        join(root, 'source.json'),
        JSON.stringify(sourceConfig(connection)),
      );
      const doctor = await sourceCli(root, 'source-doctor', env);
      expect(doctor.code, doctor.stderr).toBe(0);
      expect(JSON.parse(doctor.stdout)).toMatchObject({
        data: {
          ready: true,
          assessment: 'point-in-time',
          schema: receipt.schema,
        },
      });
      expect(
        (
          await client.query(
            'SELECT count(*)::int AS n FROM pg_replication_slots',
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      expect((await sourceCli(root, 'source-setup', env)).code).toBe(1);
      expect((await sourceCli(root, 'source-inspect', env)).stdout).toBe(
        inspected.stdout,
      );
      await client.query(
        "SELECT pg_create_logical_replication_slot('tts_cli', 'pgoutput')",
      );
      const collision = await sourceCli(root, 'source-doctor', env);
      expect(collision.code).toBe(1);
      expect(JSON.parse(collision.stderr).error.code).toBe('INVALID_HISTORY');
      for (const output of [planned, applied, inspected, doctor])
        expect(output.stdout + output.stderr).not.toContain(secret);
      await expect(stat(join(root, 'not-created'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await client.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('never authenticates through ambient passwords or pgpass when no password is configured', async () => {
  await withPostgres(async (connection) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-source-auth-'));
    const client = new pg.Client(connection);
    await client.connect();
    const secret = 'explicit-only-password';
    try {
      await client.query('CREATE TABLE items(id integer PRIMARY KEY)');
      const config = sourceConfig(connection);
      await writeFile(join(root, 'source.json'), JSON.stringify(config));
      expect(
        (
          await sourceCli(root, 'source-setup', {
            TTS_TEST_SOURCE_PASSWORD: secret,
          })
        ).code,
      ).toBe(0);
      await client.query(
        "ALTER ROLE tts_test PASSWORD 'explicit-only-password'",
      );
      await writeFile(
        join(connection.host, 'data', 'pg_hba.conf'),
        'local all all password\n',
      );
      await client.query('SELECT pg_reload_conf()');
      // The subsequent successful explicit login also proves the cluster is usable.
      const passfile = join(root, 'pgpass');
      await writeFile(passfile, `*:*:*:*:${secret}\n`, { mode: 0o600 });
      const hostile = { PGPASSWORD: secret, PGPASSFILE: passfile };
      expect(
        (
          await sourceCli(root, 'source-inspect', {
            ...hostile,
            TTS_TEST_SOURCE_PASSWORD: secret,
          })
        ).code,
      ).toBe(0);
      const withoutPassword = { ...config.connection, passwordEnv: undefined };
      await writeFile(
        join(root, 'source.json'),
        JSON.stringify({ ...config, connection: withoutPassword }),
      );
      for (const env of [hostile, { ...hostile, PGPASSWORD: undefined }]) {
        const result = await sourceCli(root, 'source-inspect', env);
        expect(result.code, result.stdout).toBe(1);
        expect(result.stdout + result.stderr).not.toContain(secret);
      }
      await writeFile(join(root, 'source.json'), JSON.stringify(config));
      expect(
        (
          await sourceCli(root, 'source-inspect', {
            ...hostile,
            TTS_TEST_SOURCE_PASSWORD: '',
          })
        ).code,
      ).toBe(1);
    } finally {
      await client.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('rolls back setup and drains its connection when the CLI deadline interrupts an observed table lock wait', async () => {
  await withPostgres(async (connection) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-source-timeout-'));
    const client = new pg.Client(connection);
    await client.connect();
    try {
      await client.query('CREATE TABLE items(id integer PRIMARY KEY)');
      await writeFile(
        join(root, 'source.json'),
        JSON.stringify(sourceConfig(connection)),
      );
      await client.query('BEGIN');
      await client.query('LOCK TABLE items IN ACCESS EXCLUSIVE MODE');
      const command = sourceCli(
        root,
        'source-setup',
        { TTS_TEST_SOURCE_PASSWORD: '' },
        ['--timeout-ms', '3000'],
      );
      let observed = false;
      const until = Date.now() + 2500;
      while (!observed && Date.now() < until) {
        await client.query('SELECT pg_stat_clear_snapshot()');
        const result = await client.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='time-travel-sql' AND wait_event_type='Lock'",
        );
        observed = result.rows[0].n > 0;
        if (!observed) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const result = await command;
      expect(observed).toBe(true);
      expect(result.code, result.stderr).toBe(124);
      expect(JSON.parse(result.stderr).error.code).toBe('TIMEOUT');
      await client.query('ROLLBACK');
      expect(
        (await client.query('SELECT count(*)::int AS n FROM pg_publication'))
          .rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (
          await client.query(
            "SELECT relreplident FROM pg_class WHERE oid='items'::regclass",
          )
        ).rows,
      ).toEqual([{ relreplident: 'd' }]);
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='time-travel-sql'",
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await client.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
