import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createLocalExporter } from '@time-travel-sql/storage-local';
import type { LocalStore } from '@time-travel-sql/storage-local';
import {
  decodePosition,
  decodeQueryRequest,
  decodeTransaction,
} from '@time-travel-sql/sdk';
import type { RecordingExport, ScanControl } from '@time-travel-sql/sdk';
import { fixture, seed } from './exchange-fixture.js';
import { metadata, row, transaction } from './storage-fixture.js';

export const request = {
  from: { kind: 'baseline' },
  to: { kind: 'after', position: decodePosition('30') },
  query: decodeQueryRequest({
    sql: 'SELECT id FROM public.orders WHERE id = 2',
  }),
} as const;
export function scanControl(controller = new AbortController()): ScanControl {
  return {
    signal: controller.signal,
    now: () => performance.now(),
    cooperate: async () => {
      await setImmediate();
    },
  };
}
export async function invariantFixture(
  work: (history: RecordingExport, source: LocalStore) => Promise<void>,
) {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await source.append(
      metadata.id,
      decodeTransaction(metadata.recording, {
        ...transaction('20', '10', '3'),
        events: [{ kind: 'delete', tableId: 'orders', before: row('2').row }],
      }),
    );
    await source.append(metadata.id, transaction('30', '20', '2'));
    await source.append(
      metadata.id,
      decodeTransaction(metadata.recording, {
        ...transaction('40', '30', '3'),
        events: [
          { kind: 'delete', tableId: 'orders', before: row('2').row },
          { kind: 'insert', tableId: 'orders', after: row('2').row },
          { kind: 'insert', tableId: 'orders', after: row('3').row },
        ],
      }),
    );
    const exporter = createLocalExporter({ path: join(root, 'source.sqlite') });
    try {
      await work(await exporter.open(metadata.id), source);
    } finally {
      await exporter.close();
    }
  });
}
