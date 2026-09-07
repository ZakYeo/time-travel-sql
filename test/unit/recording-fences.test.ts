import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openLocalStore } from '@time-travel-sql/storage-local';
import { decodePosition } from '@time-travel-sql/sdk';
import { metadata, transaction } from '../../test-support/storage-fixture.js';

async function withStores(
  work: (
    first: Awaited<ReturnType<typeof openLocalStore>>,
    second: Awaited<ReturnType<typeof openLocalStore>>,
    path: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'tts-fences-'));
  const path = join(root, 'history.sqlite');
  const first = await openLocalStore({ path });
  const second = await openLocalStore({ path });
  try {
    await first.create(metadata);
    await first.publishBaseline(metadata.id, decodePosition('0'));
    await work(first, second, path);
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
}

it('reserves without displacing an active writer, then atomically fences writes and stale release', async () => {
  await withStores(async (first, second) => {
    const old = await (await first.prepareRecording(metadata.id)).activate();
    const next = await second.prepareRecording(metadata.id);
    await old.append(metadata.id, transaction('10', '0', '1'));
    const current = await next.activate();
    await expect(
      old.append(metadata.id, transaction('20', '10', '2')),
    ).rejects.toThrow('ownership');
    await expect(old.setStatus(metadata.id, 'invalid')).rejects.toThrow(
      'ownership',
    );
    await old.close();
    await current.append(metadata.id, transaction('20', '10', '2'));
    await expect(
      first.append(metadata.id, transaction('30', '20', '3')),
    ).rejects.toThrow('ownership');
    await current.setStatus(metadata.id, 'stopped');
    await current.close();
    await expect(first.setStatus(metadata.id, 'recording')).rejects.toThrow(
      'ownership',
    );
    expect(await first.info(metadata.id)).toMatchObject({
      status: 'stopped',
      headPosition: '20',
      transactionCount: 2,
    });
  });
});

it('rejects an older delayed activation even after the newer owner releases', async () => {
  await withStores(async (first, second) => {
    const older = await first.prepareRecording(metadata.id);
    const newer = await second.prepareRecording(metadata.id);
    const owner = await newer.activate();
    await owner.close();
    await expect(older.activate()).rejects.toThrow('superseded');
    const current = await (
      await first.prepareRecording(metadata.id)
    ).activate();
    await current.append(metadata.id, transaction('10', '0', '1'));
    await current.close();
  });
});

it('rejects a stale writer after deletion and recreation of the same recording ID', async () => {
  await withStores(async (first, second) => {
    const stale = await (await first.prepareRecording(metadata.id)).activate();
    const replacement = await (
      await second.prepareRecording(metadata.id)
    ).activate();
    await replacement.close();
    await second.remove(metadata.id);
    await second.create(metadata);
    await second.publishBaseline(metadata.id, decodePosition('0'));
    const current = await (
      await second.prepareRecording(metadata.id)
    ).activate();
    await expect(
      stale.append(metadata.id, transaction('10', '0', '1')),
    ).rejects.toThrow('ownership');
    await stale.close();
    await current.append(metadata.id, transaction('10', '0', '1'));
    await current.close();
    expect((await second.info(metadata.id)).transactionCount).toBe(1);
  });
});

it('keeps generations exact beyond JavaScript integers and fails closed on exhaustion', async () => {
  await withStores(async (first, second, path) => {
    const original = await (
      await first.prepareRecording(metadata.id)
    ).activate();
    const db = new DatabaseSync(path);
    try {
      db.exec('UPDATE recording_owners SET generation=9007199254740993');
    } finally {
      db.close();
    }
    const next = await (await second.prepareRecording(metadata.id)).activate();
    const observed = new DatabaseSync(path);
    try {
      expect(
        observed
          .prepare(
            'SELECT CAST(owner_generation AS TEXT) AS value FROM recording_owners',
          )
          .get()?.value,
      ).toBe('9007199254740994');
      observed.exec(
        'UPDATE recording_owners SET generation=9223372036854775807',
      );
    } finally {
      observed.close();
    }
    await expect(first.prepareRecording(metadata.id)).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
    await original.close();
    await next.append(metadata.id, transaction('10', '0', '1'));
    await next.close();
  });
});

it('migrates intact version 3 and preserves its durable history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-fence-migration-'));
  const path = join(root, 'history.sqlite');
  let store = await openLocalStore({ path });
  try {
    await store.create(metadata);
    const before = await store.publishBaseline(
      metadata.id,
      decodePosition('0'),
    );
    await store.close();
    const db = new DatabaseSync(path);
    try {
      db.exec('DROP TABLE recording_owners; PRAGMA user_version=3');
    } finally {
      db.close();
    }
    store = await openLocalStore({ path });
    expect(await store.info(metadata.id)).toEqual(before);
    const owner = await (await store.prepareRecording(metadata.id)).activate();
    await owner.append(metadata.id, transaction('10', '0', '1'));
    await owner.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('releases writer ownership after a saturated request queue drains', async () => {
  await withStores(async (first, second) => {
    const writer = await (await first.prepareRecording(metadata.id)).activate();
    const pending = Array.from({ length: 128 }, () => first.info(metadata.id));
    const closing = writer.close();
    await Promise.all(pending);
    await closing;
    const current = await (
      await second.prepareRecording(metadata.id)
    ).activate();
    await current.close();
  });
});

it('explicit deletion fences abandoned invalid writers and permits recreation', async () => {
  await withStores(async (first, second) => {
    const abandoned = await (
      await first.prepareRecording(metadata.id)
    ).activate();
    await abandoned.setStatus(metadata.id, 'invalid');
    await second.remove(metadata.id);
    await second.create(metadata);
    await second.publishBaseline(metadata.id, decodePosition('0'));
    const current = await (
      await second.prepareRecording(metadata.id)
    ).activate();
    await expect(abandoned.setStatus(metadata.id, 'stopped')).rejects.toThrow(
      'ownership',
    );
    await abandoned.close();
    await current.append(metadata.id, transaction('10', '0', '1'));
    await current.close();
  });
});
