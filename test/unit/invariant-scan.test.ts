import { expect, it } from 'vitest';
import {
  decodePosition,
  scanInvariant,
  reconstructionRows,
  HistoryError,
} from '@time-travel-sql/sdk';
import type { HistoricalQueryEngine } from '@time-travel-sql/sdk';
import {
  invariantFixture,
  request,
  scanControl,
} from '../../test-support/invariant-fixture.js';

function engine(seen: string[], value = '2'): HistoricalQueryEngine {
  return {
    query: async (view) => {
      seen.push(view.info.position);
      const rows: string[][] = [];
      for await (const entry of reconstructionRows(view)) {
        const id = entry.row[0];
        if (id?.kind === 'scalar' && id.value === value) rows.push([id.value]);
      }
      return { columns: [{ name: 'id', typeOid: 23 }], rows };
    },
    close: async () => {
      throw new Error('Scanner must not close borrowed engine');
    },
  };
}
it('scans a nonmonotonic history in order and reports starting-state failures', async () => {
  await invariantFixture(async (history) => {
    const seen: string[] = [];
    const first = await scanInvariant(
      history,
      engine(seen),
      request,
      scanControl(),
    );
    expect(seen).toEqual(['0', '10']);
    expect(first.outcome).toMatchObject({
      kind: 'violation',
      position: '10',
      predecessor: '0',
      startingState: false,
      transaction: { position: '10', events: [{ kind: 'insert' }] },
      rows: { rows: [['2']] },
    });
    expect(first.progress).toMatchObject({
      evaluatedStates: 2,
      lastEvaluatedPosition: '10',
    });
    const recovered: string[] = [];
    const later = await scanInvariant(
      history,
      engine(recovered),
      { ...request, from: { kind: 'after', position: decodePosition('20') } },
      scanControl(),
    );
    expect(recovered).toEqual(['20', '30']);
    expect(later.outcome).toMatchObject({
      kind: 'violation',
      position: '30',
      predecessor: '20',
    });
    const initial = await scanInvariant(
      history,
      engine([], '1'),
      request,
      scanControl(),
    );
    expect(initial.outcome).toMatchObject({
      kind: 'violation',
      position: '0',
      predecessor: null,
      startingState: true,
      transaction: null,
    });
    const interior = await scanInvariant(
      history,
      engine([]),
      { ...request, from: { kind: 'after', position: decodePosition('10') } },
      scanControl(),
    );
    expect(interior.outcome).toMatchObject({
      kind: 'violation',
      position: '10',
      predecessor: '0',
      startingState: true,
    });
    const clear: string[] = [];
    expect(
      (await scanInvariant(history, engine(clear, '9'), request, scanControl()))
        .outcome,
    ).toEqual({ kind: 'clear' });
    expect(clear).toEqual(['0', '10', '20', '30']);
    const reverted = await scanInvariant(
      history,
      engine([], '3'),
      {
        ...request,
        from: { kind: 'after', position: decodePosition('30') },
        to: { kind: 'after', position: decodePosition('40') },
      },
      scanControl(),
    );
    expect(reverted.outcome).toMatchObject({
      kind: 'violation',
      position: '40',
      diff: {
        total: 1,
        counts: { inserted: 1, deleted: 0, updated: 0, unchanged: 2 },
        items: [
          {
            kind: 'insert',
            after: [{ kind: 'scalar', type: 'int4', value: '3' }],
          },
        ],
      },
    });
  });
});

it('rejects truncated baselines and broken transaction chains before evaluating invalid states', async () => {
  await invariantFixture(async (history) => {
    const baselineSeen: string[] = [];
    await expect(
      scanInvariant(
        { ...history, baseline: async () => ({ items: [], nextCursor: null }) },
        engine(baselineSeen),
        request,
        scanControl(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
    expect(baselineSeen).toEqual([]);
    const commitSeen: string[] = [];
    await expect(
      scanInvariant(
        {
          ...history,
          transactions: async () => ({
            items: [await history.transaction(decodePosition('20'))],
            nextCursor: null,
          }),
        },
        engine(commitSeen, '9'),
        request,
        scanControl(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
    expect(commitSeen).toEqual(['0']);
  });
});

it('does not count failed SQL as an evaluated state or turn SQL rejection into a clean scan', async () => {
  await invariantFixture(async (history) => {
    for (const code of [
      'LIMIT_EXCEEDED',
      'CANCELLED',
      'QUERY_REJECTED',
      'QUERY_FAILURE',
    ] as const) {
      const reader = engine([], '9');
      let calls = 0;
      const failing: HistoricalQueryEngine = {
        ...reader,
        query: async (view, query, signal) => {
          if (++calls === 2)
            throw new HistoryError(code, 'Injected query failure.');
          return reader.query(view, query, signal);
        },
      };
      const pending = scanInvariant(history, failing, request, scanControl());
      if (code === 'QUERY_REJECTED' || code === 'QUERY_FAILURE') {
        await expect(pending).rejects.toMatchObject({ code });
      } else {
        const result = await pending;
        expect(result.outcome).toEqual({
          kind: 'incomplete',
          reason: code === 'CANCELLED' ? 'cancelled' : 'limit',
        });
        expect(result.progress).toMatchObject({
          evaluatedStates: 1,
          lastEvaluatedPosition: '0',
        });
      }
    }
  });
});
it('reports incomplete work for state, prefix-replay, byte, event, cancellation and timeout limits', async () => {
  await invariantFixture(async (history) => {
    for (const limits of [
      { maxStates: 1 },
      { maxTransactions: 1 },
      { maxEvents: 1 },
      { maxBytes: 1 },
    ]) {
      const result = await scanInvariant(
        history,
        engine([], '9'),
        { ...request, limits },
        scanControl(),
      );
      expect(result.outcome).toEqual({ kind: 'incomplete', reason: 'limit' });
    }
    const seen: string[] = [];
    const prefix = await scanInvariant(
      history,
      engine(seen),
      {
        ...request,
        from: { kind: 'after', position: decodePosition('20') },
        limits: { maxTransactions: 1 },
      },
      scanControl(),
    );
    expect(prefix.outcome).toEqual({ kind: 'incomplete', reason: 'limit' });
    expect(seen).toEqual([]);
    const controller = new AbortController();
    const cancelled = await scanInvariant(history, engine([], '9'), request, {
      ...scanControl(controller),
      progress: (p) => {
        if (p.evaluatedStates === 1) controller.abort();
      },
    });
    expect(cancelled.outcome).toEqual({
      kind: 'incomplete',
      reason: 'cancelled',
    });
    expect(cancelled.progress.lastEvaluatedPosition).toBe('0');
    let now = 0;
    const timeout = await scanInvariant(
      history,
      engine([], '9'),
      { ...request, limits: { timeoutMs: 10 } },
      {
        ...scanControl(),
        now: () => now,
        progress: (p) => {
          if (p.evaluatedStates === 1) now = 10;
        },
      },
    );
    expect(timeout.outcome).toEqual({ kind: 'incomplete', reason: 'timeout' });
    const invalid: string[] = [];
    await expect(
      scanInvariant(
        history,
        engine(invalid),
        { ...request, to: { kind: 'after', position: decodePosition('9') } },
        scanControl(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_HISTORY' });
    expect(invalid).toEqual([]);
  });
});
