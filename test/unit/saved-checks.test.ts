import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { decodeSavedCheck } from '@time-travel-sql/sdk';
import {
  createLocalExporter,
  openLocalStore,
} from '@time-travel-sql/storage-local';
import {
  fixture,
  seed,
  bytesFrom,
} from '../../test-support/exchange-fixture.js';
import { metadata } from '../../test-support/storage-fixture.js';

const check = decodeSavedCheck({
  id: 'negative',
  name: 'Negative balances',
  query: { sql: 'SELECT id FROM orders WHERE id < 0' },
});

it('persists bounded definitions while pinning old SQL with old history across replacement and deletion', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    const before = await bytesFrom(root);
    expect(await source.saveCheck(metadata.id, check)).toEqual(check);
    await source.saveCheck(metadata.id, { ...check, id: 'another' });
    const first = await source.savedChecks(metadata.id, {
      cursor: null,
      limit: 1,
    });
    expect(first.items.map((item) => item.id)).toEqual(['another']);
    expect(
      (
        await source.savedChecks(metadata.id, {
          cursor: first.nextCursor,
          limit: 1,
        })
      ).items,
    ).toEqual([check]);
    const reopened = await openLocalStore({
      path: join(root, 'source.sqlite'),
    });
    try {
      expect(await reopened.savedCheck(metadata.id, check.id)).toEqual(check);
    } finally {
      await reopened.close();
    }
    expect(await bytesFrom(root)).toEqual(before);
    const exporter = createLocalExporter({ path: join(root, 'source.sqlite') });
    try {
      const history = await exporter.open(metadata.id);
      const replacement = decodeSavedCheck({
        ...check,
        query: { sql: 'SELECT 1' },
      });
      await source.saveCheck(metadata.id, replacement);
      expect(await source.savedCheck(metadata.id, check.id)).toEqual(
        replacement,
      );
      expect(await history.savedCheck(check.id)).toEqual(check);
      await source.remove(metadata.id);
      expect(await history.savedCheck(check.id)).toEqual(check);
      await history.close();
      await expect(history.savedCheck(check.id)).rejects.toBeDefined();
    } finally {
      await exporter.close();
    }
    const db = new DatabaseSync(join(root, 'source.sqlite'));
    try {
      expect(
        db.prepare('SELECT count(*) AS count FROM saved_checks').get()?.count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});

it('migrates v4 without changing authoritative history and rejects malformed definitions', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    const before = await bytesFrom(root);
    await source.close();
    const db = new DatabaseSync(join(root, 'source.sqlite'));
    try {
      db.exec('DROP TABLE saved_checks; PRAGMA user_version=4');
    } finally {
      db.close();
    }
    const migrated = await openLocalStore({
      path: join(root, 'source.sqlite'),
    });
    try {
      expect(await bytesFrom(root)).toEqual(before);
      await migrated.saveCheck(metadata.id, check);
      expect(await migrated.savedCheck(metadata.id, check.id)).toEqual(check);
      for (const invalid of [
        { ...check, name: '' },
        { ...check, id: "x'; DELETE FROM recordings; --" },
        { ...check, query: { ...check.query, sql: 'x'.repeat(65537) } },
      ]) {
        await expect(
          migrated.saveCheck(metadata.id, invalid),
        ).rejects.toBeDefined();
      }
      expect(await migrated.savedCheck(metadata.id, check.id)).toEqual(check);
      await migrated.removeCheck(metadata.id, check.id);
      await expect(
        migrated.savedCheck(metadata.id, check.id),
      ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
    } finally {
      await migrated.close();
    }
  });
});

it('enforces capacity atomically while allowing replacement, and detects damaged identity and digest', async () => {
  await fixture(async (source, _target, root) => {
    await seed(source);
    const db = new DatabaseSync(join(root, 'source.sqlite'));
    try {
      db.exec('BEGIN IMMEDIATE');
      const insert = db.prepare(
        'INSERT INTO saved_checks(recording_id,id,data,digest) VALUES(?,?,?,?)',
      );
      for (let index = 0; index < 1000; index++) {
        const value = { ...check, id: `check-${index}` };
        const data = JSON.stringify({ recordingId: metadata.id, check: value });
        insert.run(
          metadata.id,
          value.id,
          data,
          createHash('sha256').update(data).digest('hex'),
        );
      }
      db.exec('COMMIT');
      await expect(source.saveCheck(metadata.id, check)).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
      await source.saveCheck(metadata.id, { ...check, id: 'check-0' });
      expect((await source.savedCheck(metadata.id, 'check-0')).name).toBe(
        check.name,
      );
      db.exec("UPDATE saved_checks SET digest='damaged' WHERE id='check-0'");
      await expect(
        source.savedCheck(metadata.id, 'check-0'),
      ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
      db.exec("UPDATE saved_checks SET id='wrong-index' WHERE id='check-1'");
      await expect(
        source.savedCheck(metadata.id, 'wrong-index'),
      ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
    } finally {
      db.close();
    }
  });
});
