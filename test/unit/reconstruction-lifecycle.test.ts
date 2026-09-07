import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  createLocalReconstructor,
  openLocalStore,
} from '@time-travel-sql/storage-local';
import { decodePosition, decodeSelection } from '@time-travel-sql/sdk';
import { metadata, transaction } from '../../test-support/storage-fixture.js';

const request = {
  recordingId: metadata.id,
  selection: decodeSelection({ kind: 'baseline' }),
};

it('bounds owned workers and closes sessions and pending opens with their owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-reconstruct-owner-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  const reader = createLocalReconstructor({ path, maxConcurrent: 1 });
  try {
    await store.create(metadata);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    const first = await reader.open(request);
    await expect(reader.open(request)).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
    await first.close();
    await first.close();
    const second = await reader.open(request);
    await reader.close();
    await expect(
      second.rows('orders', { cursor: null, limit: 1 }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(reader.open(request)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await reader.close();
    const pendingReader = createLocalReconstructor({ path });
    const pending = pendingReader.open(request);
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await pendingReader.close();
    await rejection;
  } finally {
    await reader.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('cancels before startup, during startup and during paging without cancelling writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-reconstruct-cancel-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  const reader = createLocalReconstructor({ path, maxConcurrent: 1 });
  try {
    await store.create(metadata);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(reader.open(request, cancelled.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    const startup = new AbortController();
    const opening = reader.open(request, startup.signal);
    const rejection = expect(opening).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    startup.abort();
    await rejection;
    const controller = new AbortController();
    const session = await reader.open(request, controller.signal);
    const reading = session.rows('orders', { cursor: null, limit: 1 });
    const readRejection = expect(reading).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    controller.abort();
    await readRejection;
    await session.close();
    await expect(
      store.append(metadata.id, transaction('10', '0', '1')),
    ).resolves.toBe('appended');
    const next = await reader.open({
      ...request,
      selection: decodeSelection({ kind: 'after', position: '10' }),
    });
    expect(next.info.rowCount).toBe(1);
    await next.close();
  } finally {
    await reader.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('fails promptly on exclusive SQLite locks and releases worker capacity', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'tts-reconstruct-lock-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  await store.create(metadata);
  await store.publishBaseline(metadata.id, decodePosition('0'));
  await store.close();
  const lock = new DatabaseSync(path);
  const reader = createLocalReconstructor({ path, maxConcurrent: 1 });
  try {
    lock.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
    const started = performance.now();
    await expect(reader.open(request)).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
    });
    expect(performance.now() - started).toBeLessThan(2000);
    const controller = new AbortController();
    const pending = reader.open(request, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    controller.abort();
    await reader.close();
    await rejected;
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    await reader.close();
    lock.exec('ROLLBACK');
    lock.close();
    await rm(root, { recursive: true, force: true });
  }
});
