import pg from 'pg';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  openLocalStore,
  createLocalExporter,
} from '@time-travel-sql/storage-local';
import { withPostgres } from '../../test-support/postgres.js';
import {
  sourceConfig,
  sourceCli,
} from '../../test-support/source-cli-fixture.js';
import { captureCli } from '../../test-support/capture-cli-process.js';

it('records real commits, stops, resumes retained WAL and drains on SIGINT through the compiled command entry point', async () => {
  await withPostgres(async (connection) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-capture-cli-'));
    const path = join(root, 'history', 'history.sqlite');
    const store = await openLocalStore({ path });
    const client = new pg.Client(connection);
    await client.connect();
    try {
      await client.query('CREATE TABLE items(id integer PRIMARY KEY)');
      await client.query('INSERT INTO items VALUES (1)');
      await writeFile(
        join(root, 'source.json'),
        JSON.stringify(sourceConfig(connection)),
      );
      expect(
        (
          await sourceCli(root, 'source-setup', {
            TTS_TEST_SOURCE_PASSWORD: '',
          })
        ).code,
      ).toBe(0);
      const record = captureCli(root, [
        'record',
        'recording',
        'CLI recording',
        'source.json',
        '--duration-ms',
        '4000',
      ]);
      try {
        await expect
          .poll(
            async () => {
              try {
                return (await store.info('recording')).status;
              } catch {
                return 'missing';
              }
            },
            { timeout: 8000 },
          )
          .toBe('recording');
        await client.query('INSERT INTO items VALUES (2)');
        await expect
          .poll(async () => (await store.info('recording')).transactionCount)
          .toBe(1);
        const result = await record.done;
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).data).toMatchObject({
          status: 'stopped',
          baselineRowCount: 1,
          transactionCount: 1,
        });
        const events = result.stderr
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(
          events.every(
            (event) =>
              event.event === 'capture-progress' &&
              typeof event.data.phase === 'string',
          ),
        ).toBe(true);
      } finally {
        await record.close();
      }
      await client.query('INSERT INTO items VALUES (3)');
      const resumed = captureCli(root, [
        'resume',
        'recording',
        'source.json',
        '--duration-ms',
        '3000',
      ]);
      try {
        const result = await resumed.done;
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).data).toMatchObject({
          status: 'stopped',
          transactionCount: 2,
        });
      } finally {
        await resumed.close();
      }
      const interrupted = captureCli(root, [
        'resume',
        'recording',
        'source.json',
      ]);
      try {
        await expect
          .poll(async () => (await store.info('recording')).status)
          .toBe('recording');
        await client.query('INSERT INTO items VALUES (4)');
        await expect
          .poll(async () => (await store.info('recording')).transactionCount)
          .toBe(3);
        interrupted.child.kill('SIGINT');
        const result = await interrupted.done;
        expect(result.code, result.stderr).toBe(130);
        expect((await store.info('recording')).status).toBe('stopped');
      } finally {
        await interrupted.close();
      }
      const exporter = createLocalExporter({ path });
      try {
        const session = await exporter.open('recording');
        await session.close();
      } finally {
        await exporter.close();
      }
      expect(
        (
          await client.query(
            'SELECT slot_name, active FROM pg_replication_slots',
          )
        ).rows,
      ).toEqual([{ slot_name: 'tts_cli', active: false }]);
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='time-travel-sql'",
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      await client.query("SELECT pg_drop_replication_slot('tts_cli')");
      const missing = captureCli(root, ['resume', 'recording', 'source.json']);
      try {
        const result = await missing.done;
        expect(result.code).toBe(1);
        expect(
          JSON.parse(result.stderr.trim().split('\n').at(-1) ?? '').error.code,
        ).toBe('INVALID_HISTORY');
      } finally {
        await missing.close();
      }
      expect(
        (await client.query('SELECT slot_name FROM pg_replication_slots')).rows,
      ).toEqual([]);
    } finally {
      await client.end();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
