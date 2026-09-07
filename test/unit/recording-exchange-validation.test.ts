import { readdir } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import {
  importRecording,
  decodeRecordingFrames,
  encodeRecordingFrames,
  DEFAULT_EXCHANGE_LIMITS,
} from '@time-travel-sql/exchange';
import { decodePosition, decodeRecordingManifest } from '@time-travel-sql/sdk';
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
  collect,
} from '../../test-support/exchange-fixture.js';

it('rejects checksum-valid semantic corruption without changing existing history', async () => {
  await fixture(async (source, target, root) => {
    await seed(source);
    await target.create({ ...metadata, id: 'sentinel', name: 'Keep me' });
    const before = await target.info('sentinel');
    const frames = await collect(
      decodeRecordingFrames(values([await bytesFrom(root)]), signal()),
    );
    const manifest = decodeRecordingManifest(frames[0]);
    const cases: unknown[][] = [
      [
        { ...manifest, info: { ...manifest.info, baselineRowCount: 2 } },
        ...frames.slice(1),
      ],
      [
        {
          ...manifest,
          info: { ...manifest.info, baselineChecksum: '0'.repeat(64) },
        },
        ...frames.slice(1),
      ],
      [
        {
          ...manifest,
          info: { ...manifest.info, headPosition: '20', transactionCount: 2 },
        },
        ...frames.slice(1),
      ],
      [
        manifest,
        { kind: 'baseline', row: { ...row('1'), tableId: 'missing' } },
        frames[2],
      ],
      [
        manifest,
        frames[1],
        {
          kind: 'transaction',
          transaction: {
            ...transaction('10', '0', '2'),
            sourceId: 'wrong-source',
          },
        },
      ],
      frames.slice(1),
      [manifest, frames[2], frames[1]],
      [manifest, frames[1], frames[1], frames[2]],
      [manifest, frames[1]],
      [{ ...manifest, version: 2 }, ...frames.slice(1)],
      [
        { ...manifest, captureConfigurationFingerprint: '0'.repeat(64) },
        ...frames.slice(1),
      ],
      [
        manifest,
        frames[1],
        { kind: 'transaction', transaction: transaction('10', '0', '1') },
      ],
      [
        manifest,
        frames[1],
        { kind: 'transaction', transaction: transaction('10', '1', '2') },
      ],
    ];
    for (const invalid of cases) {
      const bytes = encodeRecordingFrames(
        values(invalid.map((frame) => JSON.stringify(frame))),
        signal(),
      );
      await expect(
        importRecording(bytes, target, signal()),
      ).rejects.toBeDefined();
      expect((await target.list(page)).items).toEqual([before]);
      expect(
        (await readdir(root)).filter((name) => name.startsWith('.tts-import-')),
      ).toEqual([]);
    }
  });
});

it('does not publish when trailer integrity fails after valid staged transactions', async () => {
  await fixture(async (source, target, root) => {
    await seed(source);
    const bytes = await bytesFrom(root);
    const corrupted = Buffer.from(
      bytes
        .toString()
        .replace(
          /"sha256":"[a-f0-9]{64}"/,
          '"sha256":"' + '0'.repeat(64) + '"',
        ),
    );
    await expect(
      importRecording(values([corrupted]), target, signal()),
    ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
    expect((await target.list(page)).items).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.tts-import-')),
    ).toEqual([]);
  });
});

it('cleans staging and input iteration when cancelled after valid data but before the trailer', async () => {
  await fixture(async (source, target, root) => {
    await seed(source);
    const buffer = await bytesFrom(root);
    const split = buffer.lastIndexOf(Buffer.from('{"end":'));
    expect(split).toBeGreaterThan(0);
    const controller = new AbortController();
    let closed = false;
    async function* input() {
      try {
        yield buffer.subarray(0, split);
        controller.abort();
        yield buffer.subarray(split);
      } finally {
        closed = true;
      }
    }
    await expect(
      importRecording(input(), target, controller.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(closed).toBe(true);
    expect((await target.list(page)).items).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.tts-import-')),
    ).toEqual([]);
  });
});

it('supports an empty published baseline and rejects a duplicate import ID', async () => {
  await fixture(async (source, target, root) => {
    await source.create(metadata);
    await source.publishBaseline(metadata.id, decodePosition('0'));
    const expected = await source.setStatus(metadata.id, 'stopped');
    const bytes = await bytesFrom(root);
    expect(await importRecording(values([bytes]), target, signal())).toEqual(
      expected,
    );
    await expect(
      importRecording(values([bytes]), target, signal()),
    ).rejects.toBeDefined();
    expect(await target.info(metadata.id)).toEqual(expected);
  });
});

it('rejects declared frame work before acquiring staging', async () => {
  await fixture(async (source, target, root) => {
    await seed(source);
    const bytes = await bytesFrom(root);
    const begin = vi.spyOn(target, 'beginImport');
    await expect(
      importRecording(values([bytes]), target, signal(), {
        ...DEFAULT_EXCHANGE_LIMITS,
        maxRecords: 2,
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(begin).not.toHaveBeenCalled();
    expect((await target.list(page)).items).toEqual([]);
  });
});
