import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { createLocalStatePairs } from '@time-travel-sql/storage-local';
import {
  compareReconstructedStates,
  decodeTransaction,
  decodePosition,
} from '@time-travel-sql/sdk';
import { fixture, seed, page } from '../../test-support/exchange-fixture.js';
import {
  metadata,
  row,
  transaction,
} from '../../test-support/storage-fixture.js';
import { control } from '../../test-support/investigation-fixture.js';
import { reconstructViews } from '../../packages/storage-local/dist/reconstruct-views.js';
import { Checkpoints } from '../../packages/storage-local/dist/checkpoints.js';

const baseline = {
  recordingId: metadata.id,
  selection: { kind: 'baseline' },
} as const;
const after = (position: string) =>
  ({
    recordingId: metadata.id,
    selection: { kind: 'after', position: decodePosition(position) },
  }) as const;

it('keeps a committed pair immutable after append/deletion and reports net key changes', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    await source.append(
      metadata.id,
      decodeTransaction(metadata.recording, {
        id: 'net-change',
        sourceId: 'source',
        epochId: 'epoch',
        schemaId: 'schema',
        position: '20',
        previousPosition: '10',
        events: [
          { kind: 'insert', tableId: 'orders', after: row('9').row },
          {
            kind: 'update',
            tableId: 'orders',
            before: row('2').row,
            after: row('3').row,
          },
          { kind: 'delete', tableId: 'orders', before: row('9').row },
        ],
      }),
    );
    const provider = createLocalStatePairs({
      path: join(root, 'source.sqlite'),
    });
    try {
      const pair = await provider.open(after('10'), after('20'));
      try {
        await source.append(metadata.id, transaction('30', '20', '4'));
        await source.remove(metadata.id);
        const result = await compareReconstructedStates(pair, {}, control());
        expect(result.counts).toEqual({
          inserted: 1,
          deleted: 1,
          updated: 0,
          unchanged: 1,
        });
        expect(
          result.items.map((item) => [item.kind, item.before ?? item.after]),
        ).toEqual([
          ['delete', row('2').row],
          ['insert', row('3').row],
        ]);
        expect(result.from.position).toBe('10');
        expect(result.to.position).toBe('20');
      } finally {
        await pair.close();
      }
      await expect(pair.from.rows('orders', page)).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      await expect(pair.to.rows('orders', page)).rejects.toMatchObject({
        code: 'CANCELLED',
      });
    } finally {
      await provider.close();
    }
  });
});

it('uses one actual SQLite snapshot even when the recording is deleted between restores', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    const path = join(root, 'source.sqlite');
    const writer = new DatabaseSync(path);
    writer.exec('PRAGMA foreign_keys=ON');
    const original = Checkpoints.prototype.restore;
    let restores = 0;
    const mock = vi
      .spyOn(Checkpoints.prototype, 'restore')
      .mockImplementation(function (this: Checkpoints, ...args) {
        const state = original.apply(this, args);
        if (++restores === 1)
          writer.prepare('DELETE FROM recordings WHERE id=?').run(metadata.id);
        return state;
      });
    try {
      const views = reconstructViews({
        kind: 'reconstruction',
        options: { path },
        requests: [baseline, after('10')],
      });
      expect(restores).toBe(2);
      expect(views.map((view) => view.info.position)).toEqual(['0', '10']);
      expect(views[1]?.tables.get('orders')).toEqual([
        row('1').row,
        row('2').row,
      ]);
      await expect(source.info(metadata.id)).rejects.toMatchObject({
        code: 'INVALID_HISTORY',
      });
    } finally {
      mock.mockRestore();
      writer.close();
    }
  });
});

it('closes both views on cancellation and releases the paired worker capacity', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    const provider = createLocalStatePairs({
      path: join(root, 'source.sqlite'),
      maxConcurrent: 1,
    });
    const controller = new AbortController();
    try {
      const pair = await provider.open(
        baseline,
        after('10'),
        controller.signal,
      );
      await expect(provider.open(baseline, after('10'))).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
      controller.abort();
      await pair.close();
      await expect(pair.to.rows('orders', page)).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      const next = await provider.open(baseline, baseline);
      await next.close();
      await expect(
        provider.open(baseline, { ...after('10'), recordingId: 'other' }),
      ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    } finally {
      await provider.close();
    }
  });
});
