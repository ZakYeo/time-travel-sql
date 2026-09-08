import pg from 'pg';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  recordNextCommit,
  decodeRecordingMetadata,
} from '@time-travel-sql/sdk';
import { createLocalExporter } from '@time-travel-sql/storage-local';
import {
  exportRecording,
  importRecording,
  prepareDerivedRecording,
} from '@time-travel-sql/exchange';
import {
  openPostgresStream,
  emitPostgresContext,
} from '@time-travel-sql/source-postgres';
import { withPostgres } from '../../test-support/postgres.js';
import { streamFixture } from '../../test-support/stream-fixture.js';
import {
  fixture,
  collect,
  values,
  signal,
} from '../../test-support/exchange-fixture.js';

it('captures context on the actual committing connection, discards rollbacks and persists portable association', async () => {
  await withPostgres(async (connection) => {
    const options = await streamFixture(connection, signal());
    const first = new pg.Client(connection);
    const second = new pg.Client(connection);
    await first.connect();
    await second.connect();
    const stream = await openPostgresStream(options);
    try {
      await fixture(async (source, target, root) => {
        const metadata = decodeRecordingMetadata({
          id: 'recording',
          name: 'Context capture',
          createdAt: '2026-01-01 00:00:00Z',
          recording: options.state.recording,
        });
        await source.create(metadata);
        await source.stageBaseline(
          metadata.id,
          metadata.recording.schema.tables.flatMap((table) =>
            options.state
              .rows(table.id)
              .map((row) => ({ tableId: table.id, row })),
          ),
        );
        await source.publishBaseline(metadata.id, options.state.position);

        await first.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await first.query('SAVEPOINT discarded');
        await emitPostgresContext(first, {
          version: 1,
          operation: 'discarded.savepoint',
        });
        await first.query('ROLLBACK TO SAVEPOINT discarded');
        await emitPostgresContext(first, {
          version: 1,
          operation: 'checkout.first',
          requestId: 'request-first',
        });
        await second.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await emitPostgresContext(second, {
          version: 1,
          operation: 'checkout.second',
          requestId: 'request-second',
        });
        expect((await second.query('SHOW transaction_isolation')).rows).toEqual(
          [{ transaction_isolation: 'serializable' }],
        );
        await second.query('UPDATE items SET value=2');
        await second.query('COMMIT');
        await first.query('UPDATE items SET value=1');
        await first.query('COMMIT');
        await first.query('BEGIN');
        await emitPostgresContext(first, {
          version: 1,
          operation: 'discarded.rollback',
        });
        await first.query('UPDATE items SET value=3');
        await first.query('ROLLBACK');
        await second.query('BEGIN');
        await second.query(
          "SELECT pg_logical_emit_message(true, 'unrelated', 'UNRELATED_PRIVATE_PAYLOAD')",
        );
        await second.query('UPDATE items SET value=4');
        await second.query('COMMIT');
        const commits = [];
        for (let index = 0; index < 3; index++)
          commits.push(await recordNextCommit(stream, source, metadata.id));
        expect(commits.map((tx) => tx.context?.operation)).toEqual([
          'checkout.second',
          'checkout.first',
          undefined,
        ]);
        expect(commits.map((tx) => tx.context?.requestId)).toEqual([
          'request-second',
          'request-first',
          undefined,
        ]);
        expect(commits.map((tx) => tx.events[0])).toMatchObject([
          { after: [{ value: '1' }, { value: '2' }] },
          { after: [{ value: '1' }, { value: '1' }] },
          { after: [{ value: '1' }, { value: '4' }] },
        ]);
        await first.query('BEGIN');
        await emitPostgresContext(first, {
          version: 1,
          operation: 'context.only',
        });
        await first.query('COMMIT');
        const contextOnly = await recordNextCommit(stream, source, metadata.id);
        expect(contextOnly.events).toEqual([]);
        expect(contextOnly.context?.operation).toBe('context.only');
        commits.push(contextOnly);
        await first.query('UPDATE items SET value=5');
        const plain = await recordNextCommit(stream, source, metadata.id);
        expect(plain.context).toBeUndefined();
        commits.push(plain);

        await first.query('BEGIN');
        await expect(
          emitPostgresContext(first, {
            version: 1,
            operation: 'invalid label',
          }),
        ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
        expect((await first.query('SELECT 42 AS value')).rows).toEqual([
          { value: 42 },
        ]);
        await first.query('ROLLBACK');
        await first.query('BEGIN');
        await expect(
          first.query('SELECT * FROM missing_context_test_table'),
        ).rejects.toMatchObject({ code: '42P01' });
        await expect(
          emitPostgresContext(first, {
            version: 1,
            operation: 'aborted.transaction',
          }),
        ).rejects.toMatchObject({ code: '25P02' });
        await first.query('ROLLBACK');
        const provider = createLocalExporter({
          path: join(root, 'source.sqlite'),
        });
        try {
          const history = await provider.open(metadata.id);
          try {
            const bytes = Buffer.concat(
              await collect(exportRecording(history, signal())),
            );
            expect(bytes.toString()).not.toContain('UNRELATED_PRIVATE_PAYLOAD');
            expect(bytes.toString()).not.toContain('discarded.');
            await importRecording(values([bytes]), target, signal());
            expect(
              (
                await target.transactions(metadata.id, {
                  cursor: null,
                  limit: 100,
                })
              ).items,
            ).toEqual(commits);
            const shared = await prepareDerivedRecording(
              history,
              {
                id: 'shared',
                name: 'Shared context-free projection',
                createdAt: metadata.createdAt,
                columnPolicy: { version: 1, rules: [] },
              },
              signal(),
            );
            const derived = Buffer.concat(
              await collect(exportRecording(shared, signal())),
            );
            expect(derived.toString()).not.toContain('request-first');
            expect(derived.toString()).not.toContain('checkout.first');
            await importRecording(values([derived]), target, signal());
            expect(
              (
                await target.transactions('shared', {
                  cursor: null,
                  limit: 100,
                })
              ).items.every((tx) => tx.context === undefined),
            ).toBe(true);
          } finally {
            await history.close();
          }
        } finally {
          await provider.close();
        }
        expect((await first.query('SELECT 42 AS value')).rows).toEqual([
          { value: 42 },
        ]);
      });
    } finally {
      await stream.close();
      await first.end();
      await second.end();
    }
  });
});
