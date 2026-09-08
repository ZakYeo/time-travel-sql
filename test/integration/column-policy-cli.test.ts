import pg from 'pg';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  openLocalStore,
  createLocalExporter,
} from '@time-travel-sql/storage-local';
import { exportRecording } from '@time-travel-sql/exchange';
import { decodeColumnPolicy } from '@time-travel-sql/sdk';
import { withPostgres } from '../../test-support/postgres.js';
import {
  sourceConfig,
  sourceCli,
} from '../../test-support/source-cli-fixture.js';
import { captureCli } from '../../test-support/capture-cli-process.js';
import { collect } from '../../test-support/exchange-fixture.js';

it('masks native snapshot/TOAST changes before SQLite and export, pins policy on resume, and rolls back invalid setup', async () => {
  await withPostgres(async (connection) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-column-policy-'));
    const path = join(root, 'history', 'history.sqlite');
    const store = await openLocalStore({ path });
    const client = new pg.Client(connection);
    await client.connect();
    const secret = 'MASKED_SOURCE_SECRET_'.repeat(300);
    const excluded = 'EXCLUDED_SOURCE_SECRET';
    const config = {
      ...sourceConfig(connection),
      columnPolicy: decodeColumnPolicy({
        version: 1,
        rules: [
          {
            namespace: 'public',
            table: 'items',
            column: 'secret',
            action: 'redact',
          },
          {
            namespace: 'public',
            table: 'items',
            column: 'excluded',
            action: 'exclude',
          },
        ],
      }),
    };
    const save = (value: unknown) =>
      writeFile(join(root, 'source.json'), JSON.stringify(value));
    const env = { TTS_TEST_SOURCE_PASSWORD: '' };
    try {
      await client.query(
        'CREATE TABLE items(id integer PRIMARY KEY, visible integer NOT NULL, secret text NOT NULL, excluded text)',
      );
      await client.query(
        'ALTER TABLE items ALTER COLUMN secret SET STORAGE EXTERNAL',
      );
      await client.query('INSERT INTO items VALUES (1,1,$1,$2)', [
        secret,
        excluded,
      ]);
      await save({
        ...config,
        columnPolicy: {
          version: 1,
          rules: [
            {
              namespace: 'public',
              table: 'items',
              column: 'id',
              action: 'redact',
            },
          ],
        },
      });
      expect((await sourceCli(root, 'source-setup', env)).code).toBe(1);
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
      await save(config);
      expect((await sourceCli(root, 'source-setup', env)).code).toBe(0);
      const doctor = await sourceCli(root, 'source-doctor', env);
      expect(doctor.code, doctor.stderr).toBe(0);
      expect(JSON.parse(doctor.stdout).data.lossy).toBe(true);
      const captured = captureCli(root, [
        'record',
        'private',
        'Projected recording',
        'source.json',
        '--duration-ms',
        '4000',
      ]);
      try {
        await expect
          .poll(
            async () => {
              try {
                return (await store.info('private')).status;
              } catch {
                return 'missing';
              }
            },
            { timeout: 8000 },
          )
          .toBe('recording');
        await client.query('BEGIN');
        await client.query('UPDATE items SET visible=2');
        await client.query('UPDATE items SET id=2, visible=3');
        await client.query('COMMIT');
        await expect
          .poll(async () => (await store.info('private')).transactionCount)
          .toBe(1);
        const result = await captured.done;
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout + result.stderr).not.toContain(
          'MASKED_SOURCE_SECRET',
        );
      } finally {
        await captured.close();
      }
      const info = await store.info('private');
      expect(info.recording.schema.tables[0]?.columns).toMatchObject([
        { name: 'id' },
        { name: 'visible' },
        { name: 'secret', capture: 'redacted' },
        { name: 'excluded', capture: 'excluded' },
      ]);
      const baseline = await store.baseline('private', {
        cursor: null,
        limit: 10,
      });
      expect(baseline.items[0]?.row.slice(2)).toEqual([
        { kind: 'unavailable', reason: 'redacted' },
        { kind: 'unavailable', reason: 'excluded' },
      ]);
      await client.query('UPDATE items SET visible=4, secret=$1, excluded=$2', [
        'ANOTHER_MASKED_SECRET',
        'ANOTHER_EXCLUDED_SECRET',
      ]);
      const resumed = captureCli(root, [
        'resume',
        'private',
        'source.json',
        '--duration-ms',
        '2000',
      ]);
      try {
        const result = await resumed.done;
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).data.transactionCount).toBe(2);
      } finally {
        await resumed.close();
      }
      await save({ ...config, columnPolicy: { version: 1, rules: [] } });
      const changed = captureCli(root, ['resume', 'private', 'source.json']);
      try {
        expect((await changed.done).code).toBe(1);
      } finally {
        await changed.close();
      }
      const exporter = createLocalExporter({ path });
      let portable: Buffer;
      try {
        const history = await exporter.open('private');
        try {
          portable = Buffer.concat(
            await collect(
              exportRecording(history, new AbortController().signal),
            ),
          );
        } finally {
          await history.close();
        }
      } finally {
        await exporter.close();
      }
      const persisted = Buffer.concat([
        await readFile(path),
        await readFile(path + '-wal'),
        portable,
      ]).toString();
      for (const marker of [
        'MASKED_SOURCE_SECRET',
        excluded,
        'ANOTHER_MASKED_SECRET',
        'ANOTHER_EXCLUDED_SECRET',
      ])
        expect(persisted).not.toContain(marker);
      expect(portable.toString()).toContain('redacted');
      expect(portable.toString()).toContain('excluded');
    } finally {
      await client.end();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
