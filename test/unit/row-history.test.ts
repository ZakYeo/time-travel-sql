import { expect, it } from 'vitest';
import {
  decodePosition,
  decodeRowHistoryOptions,
  MAX_ROW_HISTORY_OPTIONS,
  inspectRowHistory,
  decodeTransaction,
} from '@time-travel-sql/sdk';
import {
  rowHistoryFixture,
  lifecycleKey,
} from '../../test-support/row-history-fixture.js';
import { control, snapshot } from '../../test-support/investigation-fixture.js';

const request = {
  tableId: 'orders',
  key: lifecycleKey('d'),
  selection: { kind: 'after', position: decodePosition('20') },
} as const;

it('follows key moves but separates reused keys and delete/reinsert identities in one pinned offline history', async () => {
  await rowHistoryFixture(async (history, store) => {
    await store.remove(history.info.id);
    const original = await inspectRowHistory(history, request, control());
    expect(original).toMatchObject({
      origin: { kind: 'baseline', key: lifecycleKey('a') },
      status: 'deleted',
      currentKey: null,
      total: 5,
      nextOffset: null,
    });
    expect(
      original.items.map((item) => [item.kind, item.position, item.eventIndex]),
    ).toEqual([
      ['baseline', '0', null],
      ['update', '10', 0],
      ['update', '20', 0],
      ['update', '20', 1],
      ['delete', '30', 0],
    ]);
    expect(original.items[3]?.after?.[2]).toEqual({
      kind: 'unavailable',
      reason: 'redacted',
    });
    expect(original.items[2]?.committedAtMicros).toBe('2');
    const vacated = await inspectRowHistory(
      history,
      { ...request, key: lifecycleKey('b') },
      control(),
    );
    expect(vacated).toMatchObject({
      origin: { kind: 'insert', position: '20', eventIndex: 2 },
      status: 'present',
      total: 1,
    });
    const reused = await inspectRowHistory(
      history,
      {
        ...request,
        selection: { kind: 'after', position: decodePosition('30') },
      },
      control(),
    );
    expect(reused).toMatchObject({
      origin: { kind: 'insert', position: '30', eventIndex: 1 },
      status: 'present',
      currentKey: lifecycleKey('e'),
      total: 2,
    });
    expect(reused.items.map((item) => item.kind)).toEqual(['insert', 'update']);
    expect(reused.items[0]?.after?.[1]).toMatchObject({ value: '9.000' });
    const before = await inspectRowHistory(
      history,
      {
        ...request,
        selection: { kind: 'before', position: decodePosition('30') },
      },
      control(),
    );
    expect(before.items).toEqual(original.items);
    await expect(
      inspectRowHistory(
        history,
        { ...request, key: lifecycleKey('a') },
        control(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
  });
});

it('returns contiguous pages with total counts and aggregates replay budgets across both passes', async () => {
  await rowHistoryFixture(async (history) => {
    const result = await inspectRowHistory(
      history,
      { ...request, options: { limit: 1, offset: 1 } },
      control(),
    );
    expect(result).toMatchObject({
      total: 5,
      nextOffset: 2,
      items: [{ kind: 'update', position: '10' }],
      work: { replayedTransactions: 7, events: 12 },
    });
    for (const options of [
      { maxTransactions: 6 },
      { maxEvents: 11 },
      { maxInputBytes: result.work.inputBytes - 1 },
      { maxResultBytes: 1 },
    ])
      await expect(
        inspectRowHistory(history, { ...request, options }, control()),
      ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const last = await inspectRowHistory(
      history,
      { ...request, options: { offset: 4, limit: 1 } },
      control(),
    );
    expect(last).toMatchObject({
      total: 5,
      nextOffset: null,
      items: [{ kind: 'delete' }],
    });
  });
});

it('rejects corrupt or extra history after a full page and cancellation during the second pass', async () => {
  await rowHistoryFixture(async (history) => {
    const paged = { ...request, options: { limit: 1 } };
    await expect(
      inspectRowHistory(
        {
          ...history,
          transactions: async (page) => {
            const result = await history.transactions(page);
            return {
              ...result,
              items: result.items.map((tx) =>
                tx.position === '50'
                  ? decodeTransaction(history.info.recording, {
                      ...tx,
                      events: [
                        {
                          kind: 'delete',
                          tableId: 'customers',
                          before: snapshot('absent').row,
                        },
                      ],
                    })
                  : tx,
              ),
            };
          },
        },
        paged,
        control(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
    await expect(
      inspectRowHistory(
        { ...history, info: { ...history.info, transactionCount: 6 } },
        paged,
        control(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
    await expect(
      inspectRowHistory(
        {
          ...history,
          info: { ...history.info, headPosition: decodePosition('20') },
        },
        paged,
        control(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
    const controller = new AbortController();
    let baselineReads = 0;
    await expect(
      inspectRowHistory(
        {
          ...history,
          baseline: async (page) => {
            baselineReads++;
            const result = await history.baseline(page);
            if (baselineReads === 2) controller.abort();
            return result;
          },
        },
        paged,
        control(controller),
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

it('supports nonzero baseline and head anchors without inventing a creation event before coverage', async () => {
  await rowHistoryFixture(async (history) => {
    const baseline = await inspectRowHistory(
      history,
      {
        tableId: 'orders',
        key: lifecycleKey('a'),
        selection: { kind: 'baseline' },
      },
      control(),
    );
    expect(baseline.range).toEqual({ from: '100', to: '150' });
    expect(baseline.items[0]).toMatchObject({
      kind: 'baseline',
      position: '100',
      before: null,
      transactionId: null,
    });
    const head = await inspectRowHistory(
      history,
      {
        tableId: 'orders',
        key: lifecycleKey('e'),
        selection: { kind: 'after', position: decodePosition('150') },
      },
      control(),
    );
    expect(head).toMatchObject({
      origin: { kind: 'insert', position: '130', eventIndex: 1 },
      total: 2,
      status: 'present',
    });
  }, 100);
});

it('accepts the documented offset boundary and rejects values beyond it', () => {
  expect(
    decodeRowHistoryOptions({ offset: MAX_ROW_HISTORY_OPTIONS.offset }).offset,
  ).toBe(2000000);
  expect(() =>
    decodeRowHistoryOptions({ offset: MAX_ROW_HISTORY_OPTIONS.offset + 1 }),
  ).toThrow('Invalid row history limit.');
});
