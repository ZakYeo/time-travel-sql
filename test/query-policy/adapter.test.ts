import { expect, it } from 'vitest';
import { createHistoricalQueryEngine } from '@time-travel-sql/query-pglite';
import { decodeQueryRequest, scalarValue } from '@time-travel-sql/sdk';
import { pair, snapshot } from '../../test-support/investigation-fixture.js';

it('queries reconstructed values exactly with joins, expressions and duplicate names', async () => {
  const engine = createHistoricalQueryEngine();
  const view = pair(
    [],
    [
      snapshot('one', '1.234567890123456789'),
      snapshot('one', '2.00', { kind: 'null' }, 'customers'),
    ],
  ).to;
  try {
    const result = await engine.query(
      view,
      decodeQueryRequest({
        sql: 'SELECT a.id AS same, a.amount+b.amount AS same, a.note, ARRAY[9007199254740993::bigint] AS values FROM orders a JOIN customers b ON a.id=b.id',
      }),
    );
    expect(result.columns.map((column) => column.name)).toEqual([
      'same',
      'same',
      'note',
      'values',
    ]);
    expect(
      (
        await engine.query(
          view,
          decodeQueryRequest({
            sql: 'SELECT id,amount FROM orders GROUP BY id',
          }),
        )
      ).rows,
    ).toEqual([['one', '1.234567890123456789']]);
    expect(result.rows).toEqual([
      ['one', '3.234567890123456789', null, '{9007199254740993}'],
    ]);
  } finally {
    await engine.close();
  }
});

it('rejects mutations and unavailable-column reads without changing subsequent answers', async () => {
  const engine = createHistoricalQueryEngine();
  const view = pair(
    [],
    [snapshot('one', '1.00', { kind: 'unavailable', reason: 'redacted' })],
  ).to;
  try {
    for (const sql of [
      'DELETE FROM orders',
      'SELECT 1; DELETE FROM orders',
      "SELECT set_config('role','postgres',true)",
      'SELECT count(note) FROM orders',
      'COMMIT',
      'RESET ROLE',
      'CREATE TABLE unwanted(id int)',
      'CREATE EXTENSION file_fdw',
      "COPY orders TO '/tmp/tts-unwanted-output'",
      'SELECT * FROM orders FOR UPDATE',
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT query_to_xml('DELETE FROM orders',false,false,'')",
    ])
      await expect(
        engine.query(view, decodeQueryRequest({ sql })),
        sql,
      ).rejects.toMatchObject({ code: 'QUERY_REJECTED' });
    expect(
      (
        await engine.query(
          view,
          decodeQueryRequest({
            sql: 'SELECT count(*),sum(amount) FROM orders',
          }),
        )
      ).rows,
    ).toEqual([['1', '1.00']]);
    expect(
      (await view.rows('orders', { cursor: null, limit: 100 })).items[0]?.[2],
    ).toEqual({ kind: 'unavailable', reason: 'redacted' });
  } finally {
    await engine.close();
  }
}, 60000);

it('enforces result and declared input limits without partial success', async () => {
  const engine = createHistoricalQueryEngine();
  const view = pair([], [snapshot('one'), snapshot('two')]).to;
  try {
    await expect(
      engine.query(
        view,
        decodeQueryRequest({
          sql: 'SELECT id FROM orders',
          limits: { maxInputRows: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(
      engine.query(
        view,
        decodeQueryRequest({
          sql: 'SELECT id FROM orders',
          limits: { maxRows: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(
      engine.query(
        view,
        decodeQueryRequest({
          sql: 'SELECT id FROM orders',
          limits: { maxCellBytes: 2 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(
      (
        await engine.query(
          view,
          decodeQueryRequest({ sql: 'SELECT count(*) FROM orders' }),
        )
      ).rows,
    ).toEqual([['2']]);
  } finally {
    await engine.close();
  }
});

it('cancels borrowed reads, drains owned workers and releases capacity', async () => {
  const engine = createHistoricalQueryEngine();
  const controller = new AbortController();
  const ordinary = pair([], [snapshot('one')]).to;
  let entered = (): void => undefined;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = (): void => undefined;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = {
    info: ordinary.info,
    rows: async () => {
      entered();
      await stalled;
      return { items: [], nextCursor: null };
    },
  };
  try {
    const pending = engine.query(
      view,
      decodeQueryRequest({ sql: 'SELECT 1' }),
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await reading;
    await expect(
      engine.query(ordinary, decodeQueryRequest({ sql: 'SELECT 1' })),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    controller.abort();
    await rejected;
    release();
    expect(
      (await engine.query(ordinary, decodeQueryRequest({ sql: 'SELECT 1' })))
        .rows,
    ).toEqual([['1']]);
  } finally {
    release();
    await engine.close();
  }
});

it('closes an active query and rejects later work without closing its borrowed view', async () => {
  const engine = createHistoricalQueryEngine();
  const view = pair([], [snapshot('one', '1', scalarValue('text', 'data'))]).to;
  const pending = engine.query(view, decodeQueryRequest({ sql: 'SELECT 1' }));
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  await engine.close();
  await rejected;
  await engine.close();
  await expect(
    engine.query(view, decodeQueryRequest({ sql: 'SELECT 1' })),
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(
    (await view.rows('orders', { cursor: null, limit: 100 })).items,
  ).toHaveLength(1);
});
