import { expect, it } from 'vitest';
import {
  cursorQuery,
  policyFixture,
} from '../../test-support/pglite-policy.js';

it('denies unavailable column reads while retaining available queries', async () => {
  const db = await policyFixture();
  try {
    const available = [
      ['1', 'one'],
      ['2', 'two'],
    ];
    expect(
      (await cursorQuery(db, 'SELECT id,available FROM lossy ORDER BY id'))
        .rows,
    ).toEqual(available);
    expect(
      (await cursorQuery(db, 'SELECT count(*),sum(id) FROM lossy')).rows,
    ).toEqual([['2', '3']]);
    expect(
      (await cursorQuery(db, 'WITH q AS (SELECT secret FROM lossy) SELECT 1'))
        .rows,
    ).toEqual([['1']]);
    expect(
      (await cursorQuery(db, 'SELECT id FROM lossy ORDER BY id LIMIT 1')).rows,
    ).toEqual([['1']]);
    const rejected = [
      'SELECT secret FROM lossy',
      'SELECT secret FROM lossy WHERE id=2',
      'SELECT count(secret) FROM lossy',
      'SELECT secret FROM lossy WHERE false',
      'SELECT secret FROM lossy LIMIT 0',
      'SELECT * FROM lossy',
      'SELECT l FROM lossy l',
      'SELECT (l).* FROM lossy l',
      'SELECT count(l) FROM lossy l',
      'SELECT id FROM lossy WHERE secret IS NULL',
      'SELECT id FROM lossy ORDER BY secret',
      'SELECT CASE WHEN false THEN secret ELSE available END FROM lossy',
      'WITH q AS (SELECT secret FROM lossy) SELECT count(*) FROM q',
      'SELECT a.id FROM lossy a JOIN lossy b ON a.secret=b.secret',
    ];
    for (const sql of rejected) {
      await expect(cursorQuery(db, sql), sql).rejects.toMatchObject({
        code: '42501',
        message: 'permission denied for table lossy',
      });
      expect(
        (await cursorQuery(db, 'SELECT id,available FROM lossy ORDER BY id'))
          .rows,
        sql,
      ).toEqual(available);
    }
  } finally {
    await db.close();
  }
});
