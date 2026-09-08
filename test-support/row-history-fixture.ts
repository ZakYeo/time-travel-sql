import { join } from 'node:path';
import { createLocalExporter } from '@time-travel-sql/storage-local';
import type { LocalStore } from '@time-travel-sql/storage-local';
import {
  decodeRecordingMetadata,
  decodePosition,
  decodeTransaction,
  rowKey,
  findTable,
} from '@time-travel-sql/sdk';
import type { RecordingExport, RowEvent } from '@time-travel-sql/sdk';
import { fixture } from './exchange-fixture.js';
import { metadata } from './storage-fixture.js';
import { recording, snapshot } from './investigation-fixture.js';

const a = snapshot('a').row;
const b = snapshot('b', '2.00').row;
const c = snapshot('c', '2.00', {
  kind: 'unavailable',
  reason: 'redacted',
}).row;
const d = snapshot('d', '2.00', {
  kind: 'unavailable',
  reason: 'redacted',
}).row;
const replacement = snapshot('d', '9.000').row;
const e = snapshot('e', '9.000').row;
const events: readonly (readonly RowEvent[])[] = [
  [{ kind: 'update', tableId: 'orders', before: a, after: b }],
  [
    { kind: 'update', tableId: 'orders', before: b, after: c },
    { kind: 'update', tableId: 'orders', before: c, after: d },
    { kind: 'insert', tableId: 'orders', after: snapshot('b', '7.00').row },
  ],
  [
    { kind: 'delete', tableId: 'orders', before: d },
    { kind: 'insert', tableId: 'orders', after: replacement },
  ],
  [{ kind: 'update', tableId: 'orders', before: replacement, after: e }],
  [{ kind: 'insert', tableId: 'customers', after: snapshot('other').row }],
];
export const rowHistoryMetadata = decodeRecordingMetadata({
  ...metadata,
  recording,
});
export const lifecycleKey = (id: string) =>
  rowKey(recording, findTable(recording.schema, 'orders'), snapshot(id).row);
export async function rowHistoryFixture(
  work: (
    history: RecordingExport,
    store: LocalStore,
    root: string,
  ) => Promise<void>,
  baseline = 0,
) {
  await fixture(async (source, _target, root) => {
    await source.create(rowHistoryMetadata);
    await source.stageBaseline(metadata.id, [snapshot('a')]);
    await source.publishBaseline(metadata.id, decodePosition(String(baseline)));
    for (const [index, changes] of events.entries())
      await source.append(
        metadata.id,
        decodeTransaction(recording, {
          sourceId: recording.sourceId,
          epochId: recording.epochId,
          schemaId: recording.schema.id,
          id: `tx${index}`,
          previousPosition: String(baseline + index * 10),
          position: String(baseline + (index + 1) * 10),
          events: changes,
          committedAtMicros: String(index + 1),
        }),
      );
    const provider = createLocalExporter({ path: join(root, 'source.sqlite') });
    try {
      await work(await provider.open(metadata.id), source, root);
    } finally {
      await provider.close();
    }
  });
}
