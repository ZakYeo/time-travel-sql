import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../artifacts/prisma/client/client.js';
import { decodeDataFields, HistoryState } from '@time-travel-sql/sdk';
import type { SnapshotRow } from '@time-travel-sql/sdk';
import {
  openPostgresBaseline,
  openPostgresStream,
} from '@time-travel-sql/source-postgres';
import { emitPrismaContext } from '@time-travel-sql/integration-prisma';
import { prismaCheckout } from '../examples/checkout/prisma-checkout.js';

// Executed only as the isolated packed consumer, with its parent's owned cluster.
const data = decodeDataFields(JSON.parse(process.argv[2] ?? ''), [
  'host',
  'port',
  'user',
  'database',
]);
if (
  typeof data.host !== 'string' ||
  typeof data.port !== 'number' ||
  typeof data.user !== 'string' ||
  typeof data.database !== 'string'
)
  throw new Error('Invalid owned connection');
const connection = {
  host: data.host,
  port: data.port,
  user: data.user,
  database: data.database,
};
const writer = new pg.Client(connection);
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    ...connection,
    password: () => '',
    ssl: false,
    connectionTimeoutMillis: 2000,
  }),
});
await writer.connect();
try {
  await writer.query(await readFile('examples/checkout/schema.sql', 'utf8'));
  await writer.query(`ALTER TABLE inventory REPLICA IDENTITY FULL;
    ALTER TABLE orders REPLICA IDENTITY FULL;
    ALTER TABLE line_items REPLICA IDENTITY FULL;
    CREATE PUBLICATION tts_packed_prisma FOR TABLE inventory, orders, line_items;
    INSERT INTO inventory VALUES ('sku-1',10,199)`);
  const baseline = await openPostgresBaseline({
    connection,
    slot: 'tts_packed_prisma',
    sourceId: 'source',
    epochId: 'epoch',
    schemaId: 'schema',
    tables: ['inventory', 'orders', 'line_items'].map((name) => ({
      namespace: 'public',
      name,
    })),
    signal: new AbortController().signal,
  });
  try {
    const rows: SnapshotRow[] = [];
    for (
      let batch = await baseline.next();
      batch !== null;
      batch = await baseline.next()
    )
      rows.push(...batch);
    const state = HistoryState.fromSnapshot(
      baseline.recording,
      baseline.position,
      rows,
    );
    const stream = await openPostgresStream({
      connection,
      slot: 'tts_packed_prisma',
      publication: 'tts_packed_prisma',
      systemId: baseline.systemId,
      timeline: baseline.timeline,
      databaseOid: baseline.databaseOid,
      state,
      signal: new AbortController().signal,
    });
    try {
      const rollback = new Error('Rollback packed transaction');
      await assert.rejects(
        prisma.$transaction(async (transaction) => {
          await emitPrismaContext(transaction, {
            version: 1,
            operation: 'packed.rollback',
          });
          await transaction.order.create({
            data: { id: 'rolled-back', total: 1 },
          });
          throw rollback;
        }),
        (error) => error === rollback,
      );
      const order = await prismaCheckout(prisma, {
        orderId: 'packed-order',
        sku: 'sku-1',
        quantity: 2,
        requestId: 'packed-request',
      });
      assert.equal(order.total, 199);
      assert.equal(order.lines[0]?.quantity, 2);
      const commit = await stream.next();
      assert.equal(commit.context?.requestId, 'packed-request');
      assert.equal(commit.events.length, 3);
      assert.equal(state.apply(commit).rowCount, 3);
      assert.equal(await prisma.order.count(), 1);
      console.log(
        JSON.stringify({
          packedIntegration: true,
          generatedClient: true,
          rollback: true,
          context: commit.context?.operation,
        }),
      );
    } finally {
      await stream.close();
    }
  } finally {
    await baseline.close();
  }
} finally {
  await prisma.$disconnect();
  await writer.end();
}
