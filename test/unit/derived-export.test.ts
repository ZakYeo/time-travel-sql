import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  decodePosition,
  decodeRecordingInfo,
  decodeTransaction,
  decodeColumnPolicy,
  decodeRecordingDerivation,
  decodeResumableRecording,
  DERIVED_CAPABILITIES,
  HistoryState,
  scalarValue,
} from '@time-travel-sql/sdk';
import {
  exportRecording,
  exportRecordingFile,
  importRecording,
  prepareDerivedRecording,
  DEFAULT_EXCHANGE_LIMITS,
} from '@time-travel-sql/exchange';
import { createLocalExporter } from '@time-travel-sql/storage-local';
import {
  fixture,
  collect,
  values,
  signal,
} from '../../test-support/exchange-fixture.js';
import {
  recording,
  snapshot,
} from '../../test-support/investigation-fixture.js';
import { metadata } from '../../test-support/storage-fixture.js';

const policy = decodeColumnPolicy({
  version: 1,
  rules: [
    { namespace: 'public', table: 'orders', column: 'note', action: 'redact' },
  ],
});
const options = {
  id: 'shared',
  name: 'Shared projection',
  createdAt: metadata.createdAt,
  columnPolicy: policy,
};
const a = snapshot('a', '1.00', scalarValue('text', 'BASELINE_SECRET'));
const b = snapshot('b', '2.00', scalarValue('text', 'UPDATED_SECRET'));
const tx = decodeTransaction(recording, {
  id: 'tx',
  sourceId: recording.sourceId,
  epochId: recording.epochId,
  schemaId: recording.schema.id,
  previousPosition: '0',
  position: '10',
  events: [{ kind: 'update', tableId: 'orders', before: a.row, after: b.row }],
});

it('exports a separate projection, preserves replay and capabilities offline, and never mutates the original', async () => {
  await fixture(async (source, target, root) => {
    await source.create({ ...metadata, recording });
    await source.stageBaseline(metadata.id, [a]);
    await source.publishBaseline(metadata.id, decodePosition('0'));
    await source.append(metadata.id, tx);
    const provider = createLocalExporter({ path: join(root, 'source.sqlite') });
    try {
      const history = await provider.open(metadata.id);
      try {
        const original = Buffer.concat(
          await collect(exportRecording(history, signal())),
        );
        const file = join(root, 'shared.tts');
        const info = await exportRecordingFile(
          provider,
          metadata.id,
          file,
          signal(),
          undefined,
          options,
        );
        const bytes = await readFile(file);
        expect(bytes.toString()).not.toContain('BASELINE_SECRET');
        expect(bytes.toString()).not.toContain('UPDATED_SECRET');
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(info.baselineChecksum).not.toBe(history.info.baselineChecksum);
        expect(info.recording.derivation).toMatchObject({
          capabilities: DERIVED_CAPABILITIES,
          liveResume: false,
        });
        expect(() => decodeResumableRecording(info)).toThrow('resumable');
        expect(
          Buffer.concat(await collect(exportRecording(history, signal()))),
        ).toEqual(original);
        const imported = await importRecording(
          values([bytes]),
          target,
          signal(),
        );
        expect(imported).toEqual(info);
        const baseline = await target.baseline('shared', {
          cursor: null,
          limit: 100,
        });
        const transactions = await target.transactions('shared', {
          cursor: null,
          limit: 100,
        });
        let state = HistoryState.fromSnapshot(
          imported.recording,
          imported.baselinePosition,
          baseline.items,
        );
        for (const transaction of transactions.items)
          state = state.apply(transaction);
        expect(state.rows('orders')).toEqual([
          [
            scalarValue('text', 'b'),
            scalarValue('numeric', '2.00'),
            { kind: 'unavailable', reason: 'redacted' },
          ],
        ]);
        await expect(
          exportRecordingFile(
            provider,
            metadata.id,
            file,
            signal(),
            undefined,
            options,
          ),
        ).rejects.toThrow();
        expect(await readFile(file)).toEqual(bytes);
      } finally {
        await history.close();
      }
    } finally {
      await provider.close();
    }
  });
});

it('rejects original stale before-images even when projection would conceal the corruption', async () => {
  await fixture(async (source, _target, root) => {
    await source.create({ ...metadata, recording });
    await source.stageBaseline(metadata.id, [a]);
    await source.publishBaseline(metadata.id, decodePosition('0'));
    await source.append(metadata.id, tx);
    const provider = createLocalExporter({ path: join(root, 'source.sqlite') });
    const history = await provider.open(metadata.id);
    try {
      const bad = decodeTransaction(recording, {
        ...tx,
        events: [
          {
            ...tx.events[0],
            before: snapshot('a', '1.00', scalarValue('text', 'CORRUPTED')).row,
          },
        ],
      });
      await expect(
        prepareDerivedRecording(
          {
            ...history,
            transactions: async (page) => {
              expect(page.limit).toBe(1);
              return { items: [bad], nextCursor: null };
            },
          },
          options,
          signal(),
        ),
      ).rejects.toThrow('stale before-image');
      await expect(
        prepareDerivedRecording(
          history,
          { ...options, id: metadata.id },
          signal(),
        ),
      ).rejects.toThrow('distinct');
      await expect(
        prepareDerivedRecording(history, options, signal(), {
          ...DEFAULT_EXCHANGE_LIMITS,
          maxTotalBytes: 1,
        }),
      ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    } finally {
      await history.close();
      await provider.close();
    }
  });
});

it('cancels a stalled borrowed read without closing its owner and observes late rejection', async () => {
  await fixture(async (source, _target, root) => {
    await source.create({ ...metadata, recording });
    await source.publishBaseline(metadata.id, decodePosition('0'));
    const provider = createLocalExporter({ path: join(root, 'source.sqlite') });
    const history = await provider.open(metadata.id);
    const pending = Promise.withResolvers<never>();
    const started = Promise.withResolvers<void>();
    const controller = new AbortController();
    try {
      const preparation = prepareDerivedRecording(
        {
          ...history,
          baseline: async () => {
            started.resolve();
            return pending.promise;
          },
        },
        options,
        controller.signal,
      );
      const rejected = expect(preparation).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      await started.promise;
      controller.abort();
      await rejected;
      pending.reject(new Error('Late borrowed failure'));
      expect(
        (await history.baseline({ cursor: null, limit: 1 })).items,
      ).toEqual([]);
      const view = await prepareDerivedRecording(history, options, signal());
      expect('close' in view).toBe(false);
    } finally {
      await history.close();
      await provider.close();
    }
  });
});

it('validates capability data without executing accessors and seals incremental snapshot state', () => {
  let calls = 0;
  const derivation = {
    kind: 'column-policy',
    parentConfigurationFingerprint: 'a'.repeat(64),
    capabilities: {
      toJSON() {
        calls++;
        return DERIVED_CAPABILITIES;
      },
    },
    liveResume: false,
  };
  expect(() => decodeRecordingDerivation(derivation)).toThrow();
  expect(calls).toBe(0);
  const accumulator = HistoryState.beginSnapshot(recording, '0');
  accumulator.add(a);
  const state = accumulator.finish();
  expect(() => accumulator.add(b)).toThrow('sealed');
  expect(() => accumulator.finish()).toThrow('sealed');
  expect(state.rows('orders')).toEqual([a.row]);
  const failed = HistoryState.beginSnapshot(recording, '0');
  expect(() => failed.add({ ...a, row: [] })).toThrow();
  expect(() => failed.finish()).toThrow('failed');
});

it('yields during a large already-buffered baseline and cancels before consuming the remainder', async () => {
  const controller = new AbortController();
  let consumed = 0;
  const info = decodeRecordingInfo({
    ...metadata,
    recording,
    status: 'stopped',
    baselinePosition: '0',
    headPosition: '0',
    baselineRowCount: 100000,
    baselineChecksum: 'a'.repeat(64),
    transactionCount: 0,
  });
  const preparation = prepareDerivedRecording(
    {
      info,
      baseline: async (page) => {
        const start = Number(page.cursor ?? '0');
        consumed += page.limit;
        if (consumed === 5000) setImmediate(() => controller.abort());
        return {
          items: Array.from({ length: page.limit }, (_, index) =>
            snapshot(String(start + index).padStart(6, '0')),
          ),
          nextCursor: String(start + page.limit),
        };
      },
      transactions: async () => {
        throw new Error('Must cancel within baseline');
      },
      transaction: async () => {
        throw new Error('No transaction lookup');
      },
    },
    options,
    controller.signal,
  );
  await expect(preparation).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(consumed).toBeGreaterThanOrEqual(5000);
  expect(consumed).toBeLessThan(6000);
});
