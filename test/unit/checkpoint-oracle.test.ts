import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openLocalStore } from '@time-travel-sql/storage-local';
import {
  decodePosition,
  decodeSelection,
  decodeTransaction,
  HistoryState,
} from '@time-travel-sql/sdk';
import type {
  RowEvent,
  CommittedTransaction,
  SnapshotRow,
} from '@time-travel-sql/sdk';
import {
  metadata,
  row,
  transaction,
} from '../../test-support/storage-fixture.js';

function identities(rows: readonly SnapshotRow[]): Set<string> {
  return new Set(
    rows.map((entry) => {
      const value = entry.row[0];
      if (value?.kind !== 'scalar') throw new Error('Unexpected oracle row');
      return value.value;
    }),
  );
}

it('matches an independent set model at checkpoints and after every checkpoint suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-checkpoint-oracle-'));
  const store = await openLocalStore({ path: join(root, 'history.sqlite') });
  const model = new Set(['1']);
  const checkpoints = new Map<number, Set<string>>();
  const commits: CommittedTransaction[] = [];
  let nextId = 2;
  try {
    await store.create(metadata);
    await store.stageBaseline(metadata.id, [row('1')]);
    await store.publishBaseline(metadata.id, decodePosition('0'));
    for (let step = 1; step <= 90; step++) {
      const before = model.values().next().value;
      const after = String(nextId++);
      let event: RowEvent;
      if (step % 3 === 0 && before !== undefined) {
        event = { kind: 'delete', tableId: 'orders', before: row(before).row };
        model.delete(before);
      } else if (step % 3 === 1 && before !== undefined) {
        event = {
          kind: 'update',
          tableId: 'orders',
          before: row(before).row,
          after: row(after).row,
        };
        model.delete(before);
        model.add(after);
      } else {
        event = { kind: 'insert', tableId: 'orders', after: row(after).row };
        model.add(after);
      }
      const committed = decodeTransaction(metadata.recording, {
        ...transaction(String(step), String(step - 1), after),
        events: [event],
      });
      commits.push(committed);
      await store.append(metadata.id, committed);
      if (step % 15 === 0) {
        await store.publishCheckpoint(
          metadata.id,
          decodeSelection({ kind: 'after', position: String(step) }),
        );
        checkpoints.set(step, new Set(model));
      }
    }
    for (const [position, expected] of checkpoints) {
      const page = await store.checkpointRows(
        metadata.id,
        decodePosition(String(position)),
        { cursor: null, limit: 100 },
      );
      expect(page.nextCursor).toBeNull();
      expect(identities(page.items)).toEqual(expected);
      let state = HistoryState.fromSnapshot(
        metadata.recording,
        String(position),
        page.items,
      );
      for (const committed of commits.slice(position))
        state = state.apply(committed);
      expect(
        identities(
          state
            .rows('orders')
            .map((value) => ({ tableId: 'orders', row: value })),
        ),
      ).toEqual(model);
      expect(state.position).toBe('90');
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
