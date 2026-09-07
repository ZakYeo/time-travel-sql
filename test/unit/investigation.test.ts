import { expect, it, vi } from 'vitest';
import {
  compareReconstructedStates,
  inspectReconstructedRows,
  decodeInvestigationOptions,
  scalarValue,
  decodeRecordingSchema,
} from '@time-travel-sql/sdk';
import {
  pair,
  snapshot,
  control,
  recording,
} from '../../test-support/investigation-fixture.js';

it('retains legal near-limit rows when explicit changed fields make a delta exceed 4 MiB', async () => {
  const columns = Array.from({ length: 128 }, (_, index) => ({
    name: index === 0 ? 'id' : `column_${index}_${'x'.repeat(48)}`,
    type: 'text',
    nullable: false,
    typeModifier: -1,
  }));
  const schema = decodeRecordingSchema({
    ...recording,
    schema: {
      version: 1,
      id: 'schema',
      tables: [
        {
          id: 'orders',
          name: 'orders',
          namespace: 'public',
          columns,
          primaryKey: ['id'],
        },
      ],
    },
  });
  const empty = columns.map((_, index) =>
    scalarValue('text', index === 0 ? 'id' : ''),
  );
  const length = Math.floor(
    (1048576 - Buffer.byteLength(JSON.stringify(empty))) / 127,
  );
  const row = (character: string) =>
    columns.map((_, index) =>
      scalarValue('text', index === 0 ? 'id' : character.repeat(length)),
    );
  const states = pair(
    [{ tableId: 'orders', row: row('a') }],
    [{ tableId: 'orders', row: row('b') }],
    schema,
  );
  const result = await compareReconstructedStates(states, {}, control());
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.fields).toHaveLength(127);
  expect(Buffer.byteLength(JSON.stringify(result.items[0]))).toBeGreaterThan(
    4 * 1024 * 1024,
  );
});

it('reports exact deterministic net changes, fields, unavailable coverage and offset pages', async () => {
  const unavailable = { kind: 'unavailable', reason: 'redacted' } as const;
  const states = pair(
    [snapshot('a'), snapshot('b'), snapshot('same', '1', unavailable)],
    [
      snapshot('a', '1.000', scalarValue('text', '')),
      snapshot('c'),
      snapshot('same', '1', unavailable),
    ],
  );
  const result = await compareReconstructedStates(
    states,
    { limit: 2 },
    control(),
  );
  expect(result.counts).toEqual({
    inserted: 1,
    deleted: 1,
    updated: 1,
    unchanged: 1,
  });
  expect(result.total).toBe(3);
  expect(result.nextOffset).toBe(2);
  expect(result.unavailableValues).toBe(true);
  expect(result.items.map((item) => item.kind)).toEqual(['update', 'delete']);
  expect(result.items[0]?.fields.map((field) => field.column)).toEqual([
    'amount',
    'note',
  ]);
  expect(result.from.position).toBe('0');
  expect(result.to.position).toBe('20');
  const next = await compareReconstructedStates(
    states,
    { offset: 2, limit: 2 },
    control(),
  );
  expect(next.items.map((item) => item.kind)).toEqual(['insert']);
  expect(next.nextOffset).toBeNull();
  const reverse = await compareReconstructedStates(
    { ...states, from: states.to, to: states.from },
    {},
    control(),
  );
  expect(reverse.items.map((item) => item.kind)).toEqual([
    'update',
    'insert',
    'delete',
  ]);
});

it('uses schema-table order and UTF-16 row-key order with honest filtered counts', async () => {
  const states = pair(
    [],
    [
      snapshot('\uffff'),
      snapshot('𐀀'),
      snapshot('customer', '1', { kind: 'null' }, 'customers'),
    ],
  );
  const all = await compareReconstructedStates(states, {}, control());
  expect(all.items.map((item) => item.after?.[0])).toEqual([
    scalarValue('text', '𐀀'),
    scalarValue('text', '\uffff'),
    scalarValue('text', 'customer'),
  ]);
  const rows = await inspectReconstructedRows(
    states.to,
    { tableId: 'orders', limit: 1 },
    control(),
  );
  expect(rows.total).toBe(2);
  expect(rows.nextOffset).toBe(1);
  expect(rows.items[0]?.row[0]).toEqual(scalarValue('text', '𐀀'));
});

it('validates beyond the result page and in filtered-out tables before returning', async () => {
  const original = pair(
    [],
    Array.from({ length: 101 }, (_, index) => snapshot(String(index))),
  );
  const truncated = {
    ...original,
    to: {
      ...original.to,
      rows: async (
        table: string,
        request: Parameters<typeof original.to.rows>[1],
      ) => {
        const page = await original.to.rows(table, request);
        return request.cursor ? { items: [], nextCursor: null } : page;
      },
    },
  };
  await expect(
    compareReconstructedStates(truncated, { limit: 1 }, control()),
  ).rejects.toThrow('state size');
  const multiple = pair(
    [],
    [snapshot('a'), snapshot('bad', '1', { kind: 'null' }, 'customers')],
  );
  const invalid = {
    ...multiple.to,
    rows: async (
      table: string,
      request: Parameters<typeof multiple.to.rows>[1],
    ) =>
      table === 'customers'
        ? { items: [], nextCursor: null }
        : multiple.to.rows(table, request),
  };
  await expect(
    inspectReconstructedRows(invalid, { tableId: 'orders' }, control()),
  ).rejects.toThrow('state size');
});

it('rejects metadata mismatch and declared work excess before provider reads', async () => {
  const states = pair([snapshot('a')], [snapshot('b')]);
  const read = vi.spyOn(states.from, 'rows');
  await expect(
    compareReconstructedStates(states, { maxInputRows: 1 }, control()),
  ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  const mismatch = {
    ...states,
    to: {
      ...states.to,
      info: {
        ...states.to.info,
        recording: { ...states.to.info.recording, name: 'different snapshot' },
      },
    },
  };
  await expect(
    compareReconstructedStates(mismatch, {}, control()),
  ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
  expect(read).not.toHaveBeenCalled();
  expect(() => decodeInvestigationOptions({ limit: null })).toThrow();
});

it('bounds output bytes without losing total counts or accepting an oversized first result', async () => {
  const states = pair([], [snapshot('a'), snapshot('b'), snapshot('c')]);
  const full = await compareReconstructedStates(states, {}, control());
  const bytes = Buffer.byteLength(JSON.stringify(full.items.slice(0, 1)));
  const limited = await compareReconstructedStates(
    states,
    { maxResultBytes: bytes },
    control(),
  );
  expect(limited.items).toHaveLength(1);
  expect(limited.total).toBe(3);
  expect(limited.nextOffset).toBe(1);
  await expect(
    compareReconstructedStates(
      states,
      { maxResultBytes: bytes - 1 },
      control(),
    ),
  ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
});

it('cooperates with actual timer cancellation for buffered custom providers', async () => {
  const states = pair(
    [],
    Array.from({ length: 2000 }, (_, index) => snapshot(String(index))),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 0);
  try {
    await expect(
      compareReconstructedStates(states, { limit: 1 }, control(controller)),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  } finally {
    clearTimeout(timer);
  }
});
