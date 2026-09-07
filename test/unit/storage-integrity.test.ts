import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openLocalStore } from '@time-travel-sql/storage-local';
import { decodePosition, scalarValue } from '@time-travel-sql/sdk';
import {
  metadata,
  row,
  transaction,
} from '../../test-support/storage-fixture.js';

it('allows simultaneous first opens to converge on one initialized database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-initialize-'));
  const path = join(root, 'history.sqlite');
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => openLocalStore({ path })),
  );
  try {
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const first = results[0];
    if (first?.status !== 'fulfilled') throw new Error('Initial opener failed');
    await first.value.create(metadata);
    for (const result of results) {
      if (result.status === 'fulfilled')
        expect((await result.value.info(metadata.id)).name).toBe('Orders');
    }
  } finally {
    await Promise.all(
      results.map((result) =>
        result.status === 'fulfilled'
          ? result.value.close()
          : Promise.resolve(),
      ),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects a missing published baseline row and does not append on the truncated state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-baseline-integrity-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('1')]);
    expect(
      await store.publishBaseline(metadata.id, decodePosition('0')),
    ).toMatchObject({
      baselineRowCount: 1,
      baselineChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const db = new DatabaseSync(path);
    try {
      db.exec('DELETE FROM baseline');
    } finally {
      db.close();
    }
    await expect(
      store.baseline(metadata.id, { cursor: null, limit: 100 }),
    ).rejects.toThrow('completeness');
    await expect(
      store.append(metadata.id, transaction('10', '0', '2')),
    ).rejects.toThrow('completeness');
    expect((await store.info(metadata.id)).headPosition).toBe('0');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['baseline', 'transactions'])(
  'rejects a missing %s table on reopen without recreating it',
  async (table) => {
    const root = await mkdtemp(join(tmpdir(), 'tts-schema-integrity-'));
    const path = join(root, 'history.sqlite');
    const store = await openLocalStore({ path });
    await store.close();
    const db = new DatabaseSync(path);
    try {
      db.exec(`DROP TABLE ${table}`);
      await expect(openLocalStore({ path })).rejects.toThrow();
      expect(
        db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(table),
      ).toBeUndefined();
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('reads the committed WAL snapshot while another connection holds the writer lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-reader-concurrency-'));
  const path = join(root, 'history.sqlite');
  const store = await openLocalStore({ path });
  const db = new DatabaseSync(path);
  try {
    await store.create(metadata);
    db.exec('BEGIN IMMEDIATE; DELETE FROM recordings');
    expect((await store.info(metadata.id)).name).toBe('Orders');
    expect((await store.list({ cursor: null, limit: 100 })).items).toHaveLength(
      1,
    );
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects oversized requests through the promised asynchronous error contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-request-limit-'));
  const store = await openLocalStore({ path: join(root, 'history.sqlite') });
  try {
    await store.create(metadata);
    const large = {
      tableId: 'orders',
      row: [scalarValue('text', 'x'.repeat(300000))],
    };
    const result = store.stageBaseline(
      metadata.id,
      Array.from({ length: 80 }, () => large),
    );
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect((await store.info(metadata.id)).status).toBe('bootstrapping');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
