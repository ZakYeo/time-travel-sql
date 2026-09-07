import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { Client } from '../../packages/storage-local/dist/client.js';
import { expect, it, vi } from 'vitest';
import {
  openLocalStore,
  createLocalReconstructor,
} from '@time-travel-sql/storage-local';
import type { LocalStore } from '@time-travel-sql/storage-local';
import { decodePosition } from '@time-travel-sql/sdk';
import {
  metadata,
  row,
  transaction,
} from '../../test-support/storage-fixture.js';

const page = { cursor: null, limit: 100 };
async function fixture(
  work: (source: LocalStore, target: LocalStore, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'tts-import-test-'));
  const stores: LocalStore[] = [];
  const failures: unknown[] = [];
  try {
    const source = await openLocalStore({ path: join(root, 'source.sqlite') });
    stores.push(source);
    const target = await openLocalStore({ path: join(root, 'target.sqlite') });
    stores.push(target);
    await source.create(metadata);
    await source.stageBaseline(metadata.id, [row('1')]);
    await source.publishBaseline(metadata.id, decodePosition('0'));
    await source.append(metadata.id, transaction('10', '0', '2'));
    await source.setStatus(metadata.id, 'stopped');
    await work(source, target, root);
  } catch (error) {
    failures.push(error);
  } finally {
    const results = await Promise.allSettled(
      stores.map((store) => store.close()),
    );
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    for (const result of results)
      if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Import fixture failed.');
}
async function staged(
  target: LocalStore,
  signal = new AbortController().signal,
) {
  const stage = await target.beginImport(metadata, signal);
  await stage.stageBaseline([row('1')]);
  await stage.publishBaseline(decodePosition('0'));
  await stage.append(transaction('10', '0', '2'));
  return stage;
}
async function stagingPath(root: string): Promise<string> {
  const name = (await readdir(root)).find((name) =>
    name.startsWith('.tts-import-'),
  );
  if (!name) throw new Error('Expected private import directory.');
  return join(root, name, 'staging.sqlite');
}

it('keeps staged history invisible, then publishes complete offline-reconstructable history', async () => {
  await fixture(async (source, target, root) => {
    const observer = await openLocalStore({
      path: join(root, 'target.sqlite'),
    });
    const reader = createLocalReconstructor({
      path: join(root, 'target.sqlite'),
    });
    try {
      const stage = await staged(target);
      expect((await target.list(page)).items).toEqual([]);
      expect((await observer.list(page)).items).toEqual([]);
      const expected = await source.info(metadata.id);
      expect(await stage.publish(expected)).toEqual(expected);
      expect(await observer.info(metadata.id)).toEqual(expected);
      expect(await observer.captureBinding(metadata.id)).toBeNull();
      await stage.close();
      await stage.close();
      expect(
        (await readdir(root)).filter((name) => name.startsWith('.tts-import-')),
      ).toEqual([]);
      const session = await reader.open({
        recordingId: metadata.id,
        selection: { kind: 'after', position: decodePosition('10') },
      });
      try {
        expect((await session.rows('orders', page)).items).toEqual([
          row('1').row,
          row('2').row,
        ]);
      } finally {
        await session.close();
      }
    } finally {
      await reader.close();
      await observer.close();
    }
  });
});

it('rejects duplicate destination IDs and leaves existing data unchanged', async () => {
  await fixture(async (source, target) => {
    await target.create({ ...metadata, name: 'Existing sentinel' });
    const before = await target.info(metadata.id);
    const stage = await staged(target);
    try {
      await expect(
        stage.publish(await source.info(metadata.id)),
      ).rejects.toBeDefined();
    } finally {
      await stage.close();
    }
    expect(await target.info(metadata.id)).toEqual(before);
  });
});

it('rolls back publication after a late replay failure in private staged data', async () => {
  await fixture(async (source, target, root) => {
    await target.create({ ...metadata, id: 'sentinel' });
    const before = await target.info('sentinel');
    const stage = await staged(target);
    const db = new DatabaseSync(await stagingPath(root));
    try {
      const bad = JSON.stringify(transaction('10', '0', '1'));
      db.prepare('UPDATE transactions SET data=?, digest=?').run(
        bad,
        createHash('sha256').update(bad).digest('hex'),
      );
      await expect(
        stage.publish(await source.info(metadata.id)),
      ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
      expect((await target.list(page)).items).toEqual([before]);
    } finally {
      db.close();
      await stage.close();
    }
  });
});

it('rejects incomplete declarations, duplicate rows and duplicate imported transactions', async () => {
  await fixture(async (source, target) => {
    const stage = await target.beginImport(
      metadata,
      new AbortController().signal,
    );
    try {
      await stage.stageBaseline([row('1')]);
      await expect(stage.stageBaseline([row('1')])).rejects.toBeDefined();
      await stage.publishBaseline(decodePosition('0'));
      await expect(
        stage.publish(await source.info(metadata.id)),
      ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
      await stage.append(transaction('10', '0', '2'));
      await expect(
        stage.append(transaction('10', '0', '2')),
      ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
      expect((await target.list(page)).items).toEqual([]);
    } finally {
      await stage.close();
    }
  });
});

it('stages and discards without acquiring a destination write lock', async () => {
  await fixture(async (_source, target, root) => {
    const lock = new DatabaseSync(join(root, 'target.sqlite'));
    lock.exec('BEGIN IMMEDIATE');
    try {
      const stage = await staged(target);
      await stage.close();
      expect(
        (await readdir(root)).filter((name) => name.startsWith('.tts-import-')),
      ).toEqual([]);
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
  });
});

it('cancels before publication and releases listeners and private files', async () => {
  await fixture(async (source, target, root) => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const stage = await staged(target, controller.signal);
    controller.abort();
    await expect(
      stage.publish(await source.info(metadata.id)),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await stage.close();
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
    expect((await target.list(page)).items).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.tts-import-')),
    ).toEqual([]);
  });
});

it('uses independent cancellation listeners for overlapping calls', async () => {
  await fixture(async (_source, target) => {
    const controller = new AbortController();
    const stage = await target.beginImport(metadata, controller.signal);
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    try {
      const first = stage.stageBaseline([row('1')]);
      const second = stage.stageBaseline([row('2')]);
      const listeners = add.mock.calls.map((call) => call[1]);
      expect(new Set(listeners).size).toBe(2);
      await first;
      controller.abort();
      await Promise.allSettled([second]);
      expect(remove.mock.calls.map((call) => call[1])).toEqual(
        expect.arrayContaining(listeners),
      );
      await expect(
        stage.publishBaseline(decodePosition('0')),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      await stage.close();
    }
  });
});

it('removes parent-owned staging after a real worker termination', async () => {
  await fixture(async (_source, target, root) => {
    const workers = new Set<Worker>();
    const original = Worker.prototype.postMessage;
    const spy = vi
      .spyOn(Worker.prototype, 'postMessage')
      .mockImplementation(function (this: Worker, value: unknown) {
        workers.add(this);
        original.call(this, value);
      });
    try {
      await staged(target);
      expect(await stagingPath(root)).toContain('.tts-import-');
      expect(workers.size).toBe(1);
      await Promise.all([...workers].map((worker) => worker.terminate()));
      await target.close();
      expect(
        (await readdir(root)).filter((name) => name.startsWith('.tts-import-')),
      ).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

it('delivers cancellation to a publication already waiting inside the worker', async () => {
  await fixture(async (source, target, root) => {
    const controller = new AbortController();
    const stage = await staged(target, controller.signal);
    const expected = await source.info(metadata.id);
    const lock = new DatabaseSync(join(root, 'target.sqlite'));
    lock.exec('BEGIN IMMEDIATE');
    try {
      const publishing = stage.publish(expected);
      const rejected = expect(publishing).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      lock.exec('ROLLBACK');
      await rejected;
      expect((await target.list(page)).items).toEqual([]);
    } finally {
      if (lock.isTransaction) lock.exec('ROLLBACK');
      lock.close();
      await stage.close();
    }
  });
});

it('attempts directory cleanup even when worker-close reporting fails', async () => {
  await fixture(async (_source, target, root) => {
    const workers = new Set<Worker>();
    const post = Worker.prototype.postMessage;
    const spy = vi
      .spyOn(Worker.prototype, 'postMessage')
      .mockImplementation(function (this: Worker, value: unknown) {
        workers.add(this);
        post.call(this, value);
      });
    const originalClose = Client.prototype.close;
    let failingClose: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const stage = await staged(target);
      expect(workers.size).toBe(1);
      await Promise.all([...workers].map((worker) => worker.terminate()));
      failingClose = vi
        .spyOn(Client.prototype, 'close')
        .mockImplementation(async function (this: Client) {
          await originalClose.call(this);
          throw new Error('Injected close reporting failure.');
        });
      await expect(stage.close()).rejects.toMatchObject({
        errors: [
          expect.objectContaining({ code: 'STORAGE_FAILURE' }),
          expect.objectContaining({
            message: 'Injected close reporting failure.',
          }),
        ],
      });
      expect(
        (await readdir(root)).filter((name) => name.startsWith('.tts-import-')),
      ).toEqual([]);
    } finally {
      spy.mockRestore();
      failingClose?.mockRestore();
    }
  });
});
