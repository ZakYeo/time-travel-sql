import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Imports } from '../../packages/storage-local/src/imports.js';
import {
  DEFAULT_REPLAY_LIMITS,
  HistoryError,
  decodePosition,
  decodeRecordingInfo,
} from '@time-travel-sql/sdk';
import {
  openDatabase,
  atomic,
} from '../../packages/storage-local/src/database.js';
import { Reader } from '../../packages/storage-local/src/reader.js';
import { Writer } from '../../packages/storage-local/src/writer.js';
import { Checkpoints } from '../../packages/storage-local/src/checkpoints.js';
import { RecordingOwners } from '../../packages/storage-local/src/recording-owners.js';
import { metadata, row } from '../../test-support/storage-fixture.js';

it.each([2, 4])(
  'rolls back baseline preparation when cancellation arrives at scan step %s',
  async (step) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-import-scan-'));
    const db = openDatabase({ path: join(root, 'history.sqlite') });
    try {
      const reader = new Reader(db);
      const writer = new Writer(
        reader,
        new Checkpoints(reader, DEFAULT_REPLAY_LIMITS),
        new RecordingOwners(reader),
      );
      atomic(db, () => {
        writer.create(metadata);
        writer.stageBaseline(metadata.id, [row('1'), row('2'), row('3')]);
      });
      let checks = 0;
      // Steps 1–3 are canonical row reconstruction; step 4 begins the checksum scan.
      expect(() =>
        atomic(db, () =>
          writer.publishBaseline(metadata.id, decodePosition('0'), () => {
            if (++checks === step)
              throw new HistoryError('CANCELLED', 'Test scan cancellation.');
          }),
        ),
      ).toThrow('Test scan cancellation.');
      expect(checks).toBe(step);
      expect(reader.info(metadata.id).baselinePosition).toBeNull();
      expect(
        atomic(db, () =>
          writer.publishBaseline(metadata.id, decodePosition('0')),
        ).baselineRowCount,
      ).toBe(3);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('keeps staging reusable when the destination COMMIT fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-import-commit-'));
  const options = { path: join(root, 'history.sqlite') };
  const db = openDatabase(options);
  const imports = new Imports(options, DEFAULT_REPLAY_LIMITS);
  try {
    const reader = new Reader(db);
    const writer = new Writer(
      reader,
      new Checkpoints(reader, DEFAULT_REPLAY_LIMITS),
      new RecordingOwners(reader),
    );
    const token = imports.begin(metadata, new SharedArrayBuffer(4), root);
    imports.baselineComplete(token, decodePosition('0'));
    const expected = decodeRecordingInfo({
      ...metadata,
      status: 'stopped',
      baselinePosition: '0',
      headPosition: '0',
      baselineRowCount: 0,
      transactionCount: 0,
      baselineChecksum: createHash('sha256').digest('hex'),
    });
    const execute = db.exec.bind(db);
    const spy = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT') throw new Error('Injected COMMIT failure.');
      execute(sql);
    });
    try {
      expect(() =>
        atomic(db, () => imports.publish(token, expected, writer)),
      ).toThrow('Injected COMMIT failure.');
      expect(reader.list({ cursor: null, limit: 1 }).items).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(atomic(db, () => imports.publish(token, expected, writer))).toEqual(
      expected,
    );
    imports.publicationCommitted(token);
    expect(() => imports.baseline(token, [])).toThrow('already published');
  } finally {
    imports.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
