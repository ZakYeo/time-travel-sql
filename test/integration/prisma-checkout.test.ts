import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expect, it, expectTypeOf } from 'vitest';
import { PrismaClient } from '../../artifacts/prisma/client/client.js';
import type { Prisma } from '../../artifacts/prisma/client/client.js';
import { emitPrismaContext } from '@time-travel-sql/integration-prisma';
import type { PrismaContextTransaction } from '@time-travel-sql/integration-prisma';
import {
  bootstrapRecording,
  HistoryState,
  recordNextCommit,
  decodeQueryRequest,
  scanInvariant,
} from '@time-travel-sql/sdk';
import {
  openPostgresBaseline,
  openPostgresStream,
} from '@time-travel-sql/source-postgres';
import { createLocalExporter } from '@time-travel-sql/storage-local';
import { createHistoricalQueryEngine } from '@time-travel-sql/query-pglite';
import { withPostgres } from '../../test-support/postgres.js';
import { fixture, signal } from '../../test-support/exchange-fixture.js';
import { prismaCheckout } from '../../examples/checkout/prisma-checkout.js';
import { plainCheckout } from '../../examples/checkout/plain-checkout.js';

it('captures real generated Prisma nested writes, explicit context, rollback and equivalent plain SQL checkout', async () => {
  expectTypeOf<Prisma.TransactionClient>().toExtend<PrismaContextTransaction>();
  expectTypeOf<PrismaClient>().not.toExtend<PrismaContextTransaction>();
  await withPostgres(async (connection) => {
    const pool = new pg.Pool({
      ...connection,
      password: () => '',
      ssl: false,
      max: 3,
      connectionTimeoutMillis: 2000,
    });
    const prisma = new PrismaClient({
      adapter: new PrismaPg(pool, { disposeExternalPool: false }),
    });
    const writer = new pg.Client(connection);
    await writer.connect();
    try {
      await writer.query(
        await readFile('examples/checkout/schema.sql', 'utf8'),
      );
      await writer.query(`ALTER TABLE inventory REPLICA IDENTITY FULL;
        ALTER TABLE orders REPLICA IDENTITY FULL;
        ALTER TABLE line_items REPLICA IDENTITY FULL;
        CREATE PUBLICATION tts_checkout FOR TABLE inventory, orders, line_items;
        INSERT INTO inventory VALUES ('sku-1',10,199)`);
      await fixture(async (store, _target, root) => {
        const baseline = await openPostgresBaseline({
          connection,
          slot: 'tts_checkout',
          sourceId: 'source',
          epochId: 'epoch',
          schemaId: 'schema',
          tables: ['inventory', 'orders', 'line_items'].map((name) => ({
            namespace: 'public',
            name,
          })),
          signal: signal(),
        });
        try {
          const info = await bootstrapRecording(baseline, store, {
            id: 'recording',
            name: 'Checkout',
            createdAt: '2026-01-01 00:00:00Z',
          });
          const rows = await store.baseline(info.id, {
            cursor: null,
            limit: 100,
          });
          const state = HistoryState.fromSnapshot(
            info.recording,
            baseline.position,
            rows.items,
          );
          const stream = await openPostgresStream({
            connection,
            slot: 'tts_checkout',
            publication: 'tts_checkout',
            systemId: baseline.systemId,
            timeline: baseline.timeline,
            databaseOid: baseline.databaseOid,
            state,
            signal: signal(),
          });
          try {
            const invalidContext = { version: 1, operation: 'invalid.root' };
            // @ts-expect-error A root client cannot label a later application's transaction.
            const invalid = emitPrismaContext(prisma, invalidContext);
            await expect(invalid).rejects.toMatchObject({
              code: 'INVALID_VALUE',
            });
            const nested = await prisma.order.create({
              data: {
                id: 'uninstrumented',
                total: 199,
                lines: {
                  create: {
                    id: 'uninstrumented-line',
                    sku: 'sku-1',
                    quantity: 1,
                    unitPrice: 199,
                  },
                },
              },
              include: { lines: true },
            });
            expect(nested.lines).toHaveLength(1);
            const first = await recordNextCommit(stream, store, info.id);
            expect(first.context).toBeUndefined();
            expect(first.events.map((event) => event.kind)).toEqual([
              'insert',
              'insert',
            ]);
            const checkout = await prismaCheckout(prisma, {
              orderId: 'prisma-order',
              sku: 'sku-1',
              quantity: 2,
              requestId: 'prisma-request',
            });
            expect(checkout).toMatchObject({
              id: 'prisma-order',
              total: 199,
              lines: [{ quantity: 2, unitPrice: 199 }],
            });
            const second = await recordNextCommit(stream, store, info.id);
            expect(second.context?.requestId).toBe('prisma-request');
            expect(second.events).toHaveLength(3);
            const rollback = new Error('Caller rollback');
            await expect(
              prisma.$transaction(async (transaction) => {
                await emitPrismaContext(transaction, {
                  version: 1,
                  operation: 'checkout.rollback',
                });
                await transaction.order.create({
                  data: { id: 'rolled-back', total: 1 },
                });
                throw rollback;
              }),
            ).rejects.toBe(rollback);
            expect(
              await prisma.order.findUnique({ where: { id: 'rolled-back' } }),
            ).toBeNull();
            await writer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
            const plain = await plainCheckout(writer, {
              orderId: 'sql-order',
              sku: 'sku-1',
              quantity: 2,
              requestId: 'sql-request',
            });
            await writer.query('COMMIT');
            expect(plain.total).toBe(checkout.total);
            const third = await recordNextCommit(stream, store, info.id);
            expect(third.context?.requestId).toBe('sql-request');
            expect(third.events.map((event) => event.kind)).toEqual(
              second.events.map((event) => event.kind),
            );
            expect(
              await prisma.inventory.findUnique({ where: { sku: 'sku-1' } }),
            ).toMatchObject({ stock: 6 });
            await prisma.$transaction([
              prisma.inventory.update({
                where: { sku: 'sku-1' },
                data: { stock: { decrement: 1 } },
              }),
              prisma.order.update({
                where: { id: 'prisma-order' },
                data: { total: 398 },
              }),
            ]);
            expect(
              (await recordNextCommit(stream, store, info.id)).context,
            ).toBeUndefined();
            const marker = { preserved: true };
            expect(
              await prisma.$transaction(
                async (transaction) => {
                  const before = await transaction.$queryRaw<
                    { pid: number; isolation: string }[]
                  >`SELECT pg_backend_pid()::int AS pid, current_setting('transaction_isolation') AS isolation`;
                  await emitPrismaContext(transaction, {
                    version: 1,
                    operation: 'identity.proof',
                  });
                  const after = await transaction.$queryRaw<
                    { pid: number; isolation: string }[]
                  >`SELECT pg_backend_pid()::int AS pid, current_setting('transaction_isolation') AS isolation`;
                  expect(after).toEqual(before);
                  expect(after[0]?.isolation).toBe('serializable');
                  return marker;
                },
                { isolationLevel: 'Serializable' },
              ),
            ).toBe(marker);
            const last = await recordNextCommit(stream, store, info.id);
            expect(last.context?.operation).toBe('identity.proof');
            expect(last.events).toEqual([]);
            expect((await store.info(info.id)).transactionCount).toBe(5);
            const exporter = createLocalExporter({
              path: join(root, 'source.sqlite'),
            });
            const engine = createHistoricalQueryEngine();
            try {
              const history = await exporter.open(info.id);
              try {
                const result = await scanInvariant(
                  history,
                  engine,
                  {
                    from: { kind: 'baseline' },
                    to: { kind: 'after', position: last.position },
                    query: decodeQueryRequest({
                      sql: 'SELECT o.id FROM orders o JOIN line_items l ON l."orderId"=o.id GROUP BY o.id,o.total HAVING o.total <> sum(l.quantity*l."unitPrice")',
                    }),
                  },
                  {
                    signal: signal(),
                    now: () => performance.now(),
                    cooperate: async () => {
                      await setImmediate();
                    },
                  },
                );
                expect(result.outcome).toMatchObject({
                  kind: 'violation',
                  position: second.position,
                  transaction: { context: { requestId: 'prisma-request' } },
                  rows: { rows: [['prisma-order']] },
                });
              } finally {
                await history.close();
              }
            } finally {
              await engine.close();
              await exporter.close();
            }
          } finally {
            await stream.close();
          }
        } finally {
          await baseline.close();
        }
      });
      await prisma.$disconnect();
      expect((await pool.query('SELECT 42 AS value')).rows).toEqual([
        { value: 42 },
      ]);
    } finally {
      await prisma.$disconnect();
      await pool.end();
      await writer.end();
    }
  });
});
