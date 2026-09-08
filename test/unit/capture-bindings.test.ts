import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  openLocalStore,
  createLocalReconstructor,
} from '@time-travel-sql/storage-local';
import { decodeCaptureBinding, decodePosition } from '@time-travel-sql/sdk';
import { metadata } from '../../test-support/storage-fixture.js';

const binding = decodeCaptureBinding({
  adapter: 'custom',
  version: 1,
  payload: '{"stream":"orders"}',
});

it('persists an immutable binding, permits exact retries and cascades recording removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-binding-'));
  const path = join(root, 'history.sqlite');
  let store = await openLocalStore({ path });
  try {
    await store.create(metadata);
    expect(await store.captureBinding(metadata.id)).toBeNull();
    await store.bindCapture(metadata.id, binding);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.close();
    store = await openLocalStore({ path });
    expect(await store.captureBinding(metadata.id)).toEqual(binding);
    await store.bindCapture(metadata.id, binding);
    await expect(
      store.bindCapture(metadata.id, { ...binding, payload: 'changed' }),
    ).rejects.toThrow('cannot be replaced');
    await store.remove(metadata.id);
    await store.create(metadata);
    expect(await store.captureBinding(metadata.id)).toBeNull();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('serializes competing bindings and refuses a first binding after publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-binding-race-'));
  const path = join(root, 'history.sqlite');
  const first = await openLocalStore({ path });
  const second = await openLocalStore({ path });
  try {
    await first.create(metadata);
    const other = { ...binding, payload: 'other' };
    const results = await Promise.allSettled([
      first.bindCapture(metadata.id, binding),
      second.bindCapture(metadata.id, other),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const stored = await first.captureBinding(metadata.id);
    expect(stored).toEqual(
      results[0]?.status === 'fulfilled' ? binding : other,
    );
    await first.create({ ...metadata, id: 'unbound' });
    await first.publishBaseline('unbound', decodePosition('0'));
    await expect(second.bindCapture('unbound', binding)).rejects.toThrow(
      'unpublished',
    );
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects corrupted and cross-recording binding data before returning source metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-binding-corrupt-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  try {
    await store.create(metadata);
    await store.create({ ...metadata, id: 'other' });
    await store.bindCapture(metadata.id, binding);
    const db = new DatabaseSync(path);
    try {
      db.exec(
        "INSERT INTO capture_bindings SELECT 'other',data,digest FROM capture_bindings",
      );
      await expect(store.captureBinding('other')).rejects.toThrow(
        'another recording',
      );
      db.exec(
        "UPDATE capture_bindings SET digest='bad' WHERE recording_id='recording'",
      );
      await expect(store.captureBinding(metadata.id)).rejects.toThrow(
        'integrity',
      );
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('migrates intact version 2 while preserving read-only reconstruction compatibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-binding-migration-'));
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
      db.exec(
        'DROP TABLE saved_checks; DROP TABLE recording_owners; DROP TABLE capture_bindings; PRAGMA user_version=2',
      );
    } finally {
      db.close();
    }
    const reconstructor = createLocalReconstructor({ path });
    try {
      const session = await reconstructor.open({
        recordingId: metadata.id,
        selection: { kind: 'baseline' },
      });
      await session.close();
    } finally {
      await reconstructor.close();
    }
    store = await openLocalStore({ path });
    expect(await store.info(metadata.id)).toEqual(before);
    expect(await store.captureBinding(metadata.id)).toBeNull();
    const migrated = new DatabaseSync(path);
    try {
      expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(
        5,
      );
    } finally {
      migrated.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds payload bytes and rejects accessors without invoking them', () => {
  expect(() =>
    decodeCaptureBinding({ ...binding, payload: 'é'.repeat(524289) }),
  ).toThrow();
  let invoked = false;
  expect(() =>
    decodeCaptureBinding({
      adapter: 'custom',
      version: 1,
      get payload() {
        invoked = true;
        return 'x';
      },
    }),
  ).toThrow();
  expect(invoked).toBe(false);
  expect(() => decodeCaptureBinding({ ...binding, version: 0 })).toThrow();
});
