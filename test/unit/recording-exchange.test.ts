import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  createLocalExporter,
  createLocalReconstructor,
} from '@time-travel-sql/storage-local';
import { exportRecording, importRecording } from '@time-travel-sql/exchange';
import {
  decodePosition,
  decodeRecordingMetadata,
  decodeTransaction,
  scalarValue,
} from '@time-travel-sql/sdk';
import type { RecordingMetadata } from '@time-travel-sql/sdk';
import {
  metadata,
  row,
  transaction,
} from '../../test-support/storage-fixture.js';
import {
  fixture,
  seed,
  bytesFrom,
  signal,
  page,
  values,
} from '../../test-support/exchange-fixture.js';

it('writes a portable file and reopens it in a fresh offline workspace with exact committed states', async () => {
  await fixture(async (source, target, root) => {
    await seed(source);
    const tx = decodeTransaction(metadata.recording, {
      id: 'key-change',
      sourceId: 'source',
      epochId: 'epoch',
      schemaId: 'schema',
      previousPosition: '10',
      position: '20',
      committedAtMicros: '1760000000123456',
      events: [
        {
          kind: 'update',
          tableId: 'orders',
          before: row('1').row,
          after: row('3').row,
        },
        { kind: 'delete', tableId: 'orders', before: row('2').row },
        { kind: 'insert', tableId: 'orders', after: row('4').row },
      ],
    });
    await source.append(metadata.id, tx);
    const exporter = createLocalExporter({ path: join(root, 'source.sqlite') });
    const session = await exporter.open(metadata.id);
    const file = join(root, 'recording.tts');
    const exportSignal = signal();
    try {
      await pipeline(
        exportRecording(session, exportSignal),
        createWriteStream(file, { flags: 'wx', mode: 0o600 }),
        { signal: exportSignal },
      );
    } finally {
      await session.close();
      await exporter.close();
    }
    await source.close();
    const controller = new AbortController();
    const imported = await importRecording(
      createReadStream(file, { highWaterMark: 7, signal: controller.signal }),
      target,
      controller.signal,
    );
    expect(imported).toMatchObject({
      status: 'interrupted',
      baselinePosition: '0',
      headPosition: '20',
      transactionCount: 2,
    });
    expect(await target.captureBinding(metadata.id)).toBeNull();
    expect((await target.transactions(metadata.id, page)).items).toEqual([
      transaction('10', '0', '2'),
      tx,
    ]);
    await target.close();
    const reader = createLocalReconstructor({
      path: join(root, 'target.sqlite'),
    });
    try {
      for (const [position, expected] of [
        ['10', ['1', '2']],
        ['20', ['3', '4']],
      ] as const) {
        const selected = await reader.open({
          recordingId: metadata.id,
          selection: { kind: 'after', position: decodePosition(position) },
        });
        try {
          expect((await selected.rows('orders', page)).items).toEqual(
            expected.map((value) => row(value).row),
          );
        } finally {
          await selected.close();
        }
      }
    } finally {
      await reader.close();
    }
  });
});

it('pins export across concurrent append and deletion of the source recording', async () => {
  await fixture(async (source, target, root) => {
    await seed(source);
    const exporter = createLocalExporter({ path: join(root, 'source.sqlite') });
    const session = await exporter.open(metadata.id);
    try {
      await source.append(metadata.id, transaction('20', '10', '3'));
      await source.remove(metadata.id);
      const info = await importRecording(
        exportRecording(session, signal()),
        target,
        signal(),
      );
      expect(info.headPosition).toBe('10');
      expect(info.transactionCount).toBe(1);
    } finally {
      await session.close();
      await exporter.close();
    }
  });
});

it('exports authoritative history even when excluded checkpoint data is corrupt', async () => {
  await fixture(async (source, target, root) => {
    await seed(source);
    await source.append(metadata.id, transaction('2000', '10', '3'));
    await source.publishCheckpoint(metadata.id, {
      kind: 'after',
      position: decodePosition('2000'),
    });
    const db = new DatabaseSync(join(root, 'source.sqlite'));
    try {
      db.exec(
        "UPDATE checkpoints SET data='broken',digest='broken'; UPDATE checkpoint_rows SET data='broken',digest='broken'",
      );
      // Exceeds the old checkpoint fallback candidate budget. None is authoritative.
      const insert = db.prepare(
        'INSERT INTO checkpoints(recording_id,position,data,digest) VALUES(?,?,?,?)',
      );
      db.exec('BEGIN');
      for (let position = 100; position <= 1100; position++)
        insert.run(
          metadata.id,
          String(position).padStart(40, '0'),
          'broken',
          'broken',
        );
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const checkpointReader = createLocalReconstructor({
      path: join(root, 'source.sqlite'),
    });
    try {
      await expect(
        checkpointReader.open({
          recordingId: metadata.id,
          selection: { kind: 'after', position: decodePosition('2000') },
        }),
      ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    } finally {
      await checkpointReader.close();
    }
    expect(
      (await importRecording(values([await bytesFrom(root)]), target, signal()))
        .headPosition,
    ).toBe('2000');
    expect((await target.checkpoints(metadata.id, page)).items).toEqual([]);
  });
});

it('preserves exact values and UTF-8 baseline order through a round trip', async () => {
  await fixture(async (source, target, root) => {
    const scalars = [
      scalarValue('int8', '9223372036854775807'),
      scalarValue('numeric', '12345678901234567890.123456789'),
      scalarValue('timestamp', '2026-01-02 03:04:05.123456'),
      scalarValue('jsonb', '{"n":90071992547409931234567890,"nothing":null}'),
      scalarValue('bytea', '\\x00ff'),
    ];
    const data: RecordingMetadata = decodeRecordingMetadata({
      ...metadata,
      recording: {
        ...metadata.recording,
        schema: {
          ...metadata.recording.schema,
          tables: [
            {
              id: 'orders',
              namespace: 'public',
              name: 'orders',
              primaryKey: ['key'],
              columns: [
                {
                  name: 'key',
                  type: 'text',
                  nullable: false,
                  typeModifier: -1,
                },
                ...scalars.map((value, index) => ({
                  name: 'v' + index,
                  type: value.type,
                  nullable: false,
                  typeModifier: -1,
                })),
              ],
            },
          ],
        },
      },
    });
    await source.create(data);
    const rows = ['\ue000', '🦆'].map((key) => ({
      tableId: 'orders',
      row: [scalarValue('text', key), ...scalars],
    }));
    await source.stageBaseline(data.id, rows);
    await source.publishBaseline(data.id, decodePosition('0'));
    const info = await source.setStatus(data.id, 'stopped');
    expect(
      await importRecording(values([await bytesFrom(root)]), target, signal()),
    ).toEqual(info);
    expect((await target.baseline(data.id, page)).items).toEqual(rows);
  });
});

it('bounds pinned export sessions and releases capacity after cancellation and closure', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    const exporter = createLocalExporter({
      path: join(root, 'source.sqlite'),
      maxConcurrent: 1,
    });
    const controller = new AbortController();
    try {
      const session = await exporter.open(metadata.id, controller.signal);
      await expect(exporter.open(metadata.id)).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
      controller.abort();
      await expect(session.baseline(page)).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      await session.close();
      const next = await exporter.open(metadata.id);
      expect(next.info.headPosition).toBe('10');
      await exporter.close();
      await expect(next.transactions(page)).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      await expect(exporter.open(metadata.id)).rejects.toMatchObject({
        code: 'CANCELLED',
      });
    } finally {
      await exporter.close();
    }
  });
});
