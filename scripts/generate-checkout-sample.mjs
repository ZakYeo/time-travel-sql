import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeRecordingMetadata,
  decodeTransaction,
  scalarValue,
} from '@time-travel-sql/sdk';
import {
  openLocalStore,
  createLocalExporter,
} from '@time-travel-sql/storage-local';
import { exportRecordingFile } from '@time-travel-sql/exchange';

// Synthetic, deterministic teaching data. This does not claim source capture.
const check = process.argv[2] === '--check';
if (process.argv.length > (check ? 3 : 2))
  throw new Error('Usage: node scripts/generate-checkout-sample.mjs [--check]');
const column = (name, type) => ({
  name,
  type,
  nullable: false,
  typeModifier: -1,
});
const table = (name, columns) => ({
  id: name,
  namespace: 'public',
  name,
  columns,
  primaryKey: [columns[0].name],
});
const metadata = decodeRecordingMetadata({
  id: 'sample-checkout-v1',
  name: 'Sample: checkout totals',
  createdAt: '2026-01-01T00:00:00Z',
  recording: {
    sourceId: 'sample-checkout',
    epochId: 'sample-v1',
    schema: {
      version: 1,
      id: 'checkout-v1',
      tables: [
        table('inventory', [
          column('sku', 'text'),
          column('stock', 'int4'),
          column('unitPrice', 'int4'),
        ]),
        table('orders', [column('id', 'text'), column('total', 'int4')]),
        table('line_items', [
          column('id', 'text'),
          column('orderId', 'text'),
          column('sku', 'text'),
          column('quantity', 'int4'),
          column('unitPrice', 'int4'),
        ]),
      ],
    },
  },
});
const text = (value) => scalarValue('text', value);
const integer = (value) => scalarValue('int4', String(value));
const inventory = (stock) => [text('coffee'), integer(stock), integer(199)];
const order = (id, total) => [text(id), integer(total)];
const line = (id, quantity) => [
  text(id + '-line'),
  text(id),
  text('coffee'),
  integer(quantity),
  integer(199),
];
const insert = (tableId, after) => ({ kind: 'insert', tableId, after });
const update = (tableId, before, after) => ({
  kind: 'update',
  tableId,
  before,
  after,
});
const remove = (tableId, before) => ({ kind: 'delete', tableId, before });
const steps = [
  [
    'checkout.create',
    [
      insert('orders', order('order-1', 199)),
      insert('line_items', line('order-1', 1)),
      update('inventory', inventory(10), inventory(9)),
    ],
  ],
  // Intentional bug: total omits quantity, exactly as in the Prisma example.
  [
    'checkout.create',
    [
      insert('orders', order('order-2', 199)),
      insert('line_items', line('order-2', 2)),
      update('inventory', inventory(9), inventory(7)),
    ],
  ],
  [
    'checkout.correct-total',
    [update('orders', order('order-2', 199), order('order-2', 398))],
  ],
  [
    'checkout.cancel',
    [
      remove('line_items', line('order-1', 1)),
      remove('orders', order('order-1', 199)),
      update('inventory', inventory(7), inventory(8)),
    ],
  ],
];
const root = await mkdtemp(join(tmpdir(), 'tts-sample-build-'));
try {
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [
      { tableId: 'inventory', row: inventory(10) },
    ]);
    await store.publishBaseline(metadata.id, '0');
    for (const [index, [operation, events]] of steps.entries()) {
      await store.append(
        metadata.id,
        decodeTransaction(metadata.recording, {
          id: 'sample-tx-' + (index + 1),
          sourceId: metadata.recording.sourceId,
          epochId: metadata.recording.epochId,
          schemaId: metadata.recording.schema.id,
          position: String((index + 1) * 10),
          previousPosition: String(index * 10),
          committedAtMicros: String(
            1767225600000000n + BigInt(index + 1) * 1000000n,
          ),
          context: {
            version: 1,
            operation,
            requestId: 'sample-request-' + (index + 1),
          },
          events,
        }),
      );
    }
    await store.setStatus(metadata.id, 'stopped');
  } finally {
    await store.close();
  }
  const exporter = createLocalExporter({ path });
  try {
    await exportRecordingFile(
      exporter,
      metadata.id,
      join(root, 'checkout.tts'),
      new AbortController().signal,
    );
  } finally {
    await exporter.close();
  }
  const assets = new URL('../apps/cli/assets/', import.meta.url);
  const destination = new URL('checkout.tts', assets);
  const bytes = await readFile(join(root, 'checkout.tts'));
  if (check) {
    if (!bytes.equals(await readFile(destination)))
      throw new Error('Bundled checkout sample differs from its generator.');
  } else {
    await mkdir(assets, { recursive: true });
    await writeFile(destination, bytes);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
