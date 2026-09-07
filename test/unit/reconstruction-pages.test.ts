import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  createLocalReconstructor,
  openLocalStore,
} from '@time-travel-sql/storage-local';
import {
  decodePosition,
  decodeRecordingMetadata,
  decodeSelection,
  reconstructionRows,
  scalarValue,
} from '@time-travel-sql/sdk';
import { metadata } from '../../test-support/storage-fixture.js';

it('streams a reconstructed state larger than the transport ceiling in bounded pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-reconstruct-pages-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  const reader = createLocalReconstructor({ path });
  const sourceTable = metadata.recording.schema.tables[0];
  if (!sourceTable) throw new Error('Missing fixture table');
  const recording = decodeRecordingMetadata({
    ...metadata,
    recording: {
      ...metadata.recording,
      schema: {
        ...metadata.recording.schema,
        tables: [
          {
            ...sourceTable,
            columns: [
              ...sourceTable.columns,
              { name: 'note', type: 'text', nullable: false, typeModifier: -1 },
            ],
          },
        ],
      },
    },
  });
  const note = scalarValue('text', 'x'.repeat(700000));
  const rows = Array.from({ length: 32 }, (_, index) => ({
    tableId: 'orders',
    row: [scalarValue('int4', String(index)), note],
  }));
  try {
    await store.create(recording);
    await store.stageBaseline(metadata.id, rows.slice(0, 16));
    await store.stageBaseline(metadata.id, rows.slice(16));
    await store.publishBaseline(metadata.id, decodePosition('0'));
    const session = await reader.open({
      recordingId: metadata.id,
      selection: decodeSelection({ kind: 'baseline' }),
    });
    const first = await session.rows('orders', { cursor: null, limit: 100 });
    expect(first.nextCursor).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(
      20 * 1024 * 1024,
    );
    const second = await session.rows('orders', {
      cursor: first.nextCursor,
      limit: 100,
    });
    expect(first.items.length + second.items.length).toBe(32);
    expect(second.nextCursor).toBeNull();
    let count = 0;
    for await (const value of reconstructionRows(session)) {
      expect(value.row[1]).toEqual(note);
      count++;
    }
    expect(count).toBe(32);
    await session.close();
  } finally {
    await reader.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
