import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openLocalStore } from '@time-travel-sql/storage-local';
import {
  decodeRecordingMetadata,
  decodePosition,
  decodeTransaction,
  scalarValue,
} from '@time-travel-sql/sdk';

import {
  metadata,
  row,
  transaction,
} from '../../test-support/storage-fixture.js';

it('atomically publishes a staged baseline, persists commits, and reopens with exact duplicate detection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-storage-'));
  const path = join(root, 'history.sqlite');
  let store = await openLocalStore({ path });
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('1')]);
    expect((await store.info(metadata.id)).status).toBe('bootstrapping');
    await expect(
      store.baseline(metadata.id, { cursor: null, limit: 10 }),
    ).rejects.toThrow();
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.append(metadata.id, transaction('10', '0', '2'));
    await store.append(metadata.id, transaction('20', '10', '3'));
    await store.close();
    store = await openLocalStore({ path });
    expect((await store.info(metadata.id)).headPosition).toBe('20');
    expect(await store.append(metadata.id, transaction('10', '0', '2'))).toBe(
      'duplicate',
    );
    await expect(
      store.append(metadata.id, transaction('10', '0', '9')),
    ).rejects.toThrow();
    const first = await store.transactions(metadata.id, {
      cursor: null,
      limit: 1,
    });
    const second = await store.transactions(metadata.id, {
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(first.items.map((item) => item.position)).toEqual(['10']);
    expect(second.items.map((item) => item.position)).toEqual(['20']);
    expect(
      (await store.baseline(metadata.id, { cursor: null, limit: 10 })).items,
    ).toEqual([row('1')]);
    expect((await store.info(metadata.id)).transactionCount).toBe(2);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rolls back a failed staging batch and retains unpublished rows across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-staging-'));
  const path = join(root, 'history.sqlite');
  let store = await openLocalStore({ path });
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('1')]);
    await expect(
      store.stageBaseline(metadata.id, [row('2'), row('1')]),
    ).rejects.toThrow();
    await store.close();
    store = await openLocalStore({ path });
    expect((await store.info(metadata.id)).status).toBe('bootstrapping');
    await store.publishBaseline(metadata.id, decodePosition('0'));
    expect(
      (await store.baseline(metadata.id, { cursor: null, limit: 100 })).items,
    ).toEqual([row('1')]);
    await expect(
      store.stageBaseline(metadata.id, [row('3')]),
    ).rejects.toThrow();
    await expect(
      store.publishBaseline(metadata.id, decodePosition('0')),
    ).rejects.toThrow();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not advance progress on SQLITE_FULL and can continue after the failed write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-full-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path, maxBytes: 65536 });
  const sourceTable = metadata.recording.schema.tables[0];
  if (!sourceTable) throw new Error('Missing fixture table');
  const textMetadata = decodeRecordingMetadata({
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
  const change = (note: string) =>
    decodeTransaction(textMetadata.recording, {
      ...transaction('10', '0', '1'),
      events: [
        {
          kind: 'insert',
          tableId: 'orders',
          after: [scalarValue('int4', '1'), scalarValue('text', note)],
        },
      ],
    });
  try {
    await store.create(textMetadata);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await expect(
      store.append(metadata.id, change('x'.repeat(100000))),
    ).rejects.toThrow();
    expect(await store.info(metadata.id)).toMatchObject({
      headPosition: '0',
      transactionCount: 0,
    });
    expect(
      (await store.transactions(metadata.id, { cursor: null, limit: 100 }))
        .items,
    ).toEqual([]);
    await store.append(metadata.id, change('fits'));
    expect((await store.info(metadata.id)).headPosition).toBe('10');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('detects external corruption even when the current head was cached', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-corrupt-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  try {
    await store.create(metadata);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.append(metadata.id, transaction('10', '0', '1'));
    const db = new DatabaseSync(path);
    try {
      db.prepare('UPDATE transactions SET data=?').run('{}');
    } finally {
      db.close();
    }
    await expect(
      store.transaction(metadata.id, decodePosition('10')),
    ).rejects.toThrow('integrity');
    await expect(
      store.append(metadata.id, transaction('20', '10', '2')),
    ).rejects.toThrow('integrity');
    expect((await store.info(metadata.id)).headPosition).toBe('10');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([0, 99])(
  'rejects foreign or future database version %i without changing its contents',
  async (version) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-version-'));
    const path = join(root, 'history.sqlite');
    const db = new DatabaseSync(path);
    try {
      db.exec(
        `CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserved'); PRAGMA user_version=${version}`,
      );
      await expect(openLocalStore({ path })).rejects.toThrow();
      expect(db.prepare('SELECT * FROM sentinel').all()).toEqual([
        { value: 'preserved' },
      ]);
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(
        version,
      );
      expect(
        db.prepare('SELECT name FROM sqlite_schema WHERE type=?').all('table'),
      ).toEqual([{ name: 'sentinel' }]);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('drains accepted operations on close and deletes entire recordings with their history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-close-'));
  const path = join(root, 'history.sqlite');
  let store = await openLocalStore({ path });
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('1')]);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    const append = store.append(metadata.id, transaction('10', '0', '2'));
    const closing = store.close();
    await expect(append).resolves.toBe('appended');
    await closing;
    await store.close();
    await expect(store.info(metadata.id)).rejects.toThrow('closed');
    store = await openLocalStore({ path });
    expect((await store.info(metadata.id)).transactionCount).toBe(1);
    await store.remove(metadata.id);
    expect((await store.list({ cursor: null, limit: 100 })).items).toEqual([]);
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('SELECT count(*) AS n FROM baseline').get()?.n).toBe(0);
      expect(
        db.prepare('SELECT count(*) AS n FROM transactions').get()?.n,
      ).toBe(0);
    } finally {
      db.close();
    }
    await store.create(metadata);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    await store.append(metadata.id, transaction('10', '0', '2'));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves history and progress when a later event fails, including concurrent writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-storage-'));
  const path = join(root, 'history.sqlite');
  const first = await openLocalStore({ path });
  const second = await openLocalStore({ path });
  try {
    await first.create(metadata);
    await first.publishBaseline(metadata.id, decodePosition('0'));
    await first.append(metadata.id, transaction('10', '0', '1'));
    await second.append(metadata.id, transaction('20', '10', '2'));
    const bad = decodeTransaction(metadata.recording, {
      ...transaction('30', '20', '3'),
      events: [
        ...transaction('30', '20', '3').events,
        { kind: 'delete', tableId: 'orders', before: row('9').row },
      ],
    });
    await expect(first.append(metadata.id, bad)).rejects.toThrow();
    expect((await second.info(metadata.id)).headPosition).toBe('20');
    await expect(
      second.transaction(metadata.id, decodePosition('30')),
    ).rejects.toThrow();
    await first.setStatus(metadata.id, 'stopped');
    await expect(
      second.append(metadata.id, transaction('30', '20', '3')),
    ).rejects.toThrow();
    await first.rename(metadata.id, 'Renamed');
    expect((await second.info(metadata.id)).name).toBe('Renamed');
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});
