import { HistoryError } from '../domain/errors.js';
import { HistoryState } from '../domain/state.js';
import { decodeTransaction, TRANSACTION_LIMITS } from '../domain/events.js';
import type { CommittedTransaction } from '../domain/events.js';
import { comparePositions } from '../domain/position.js';
import { decodeSnapshotRow, decodePageRequest } from '../domain/recordings.js';
import type { SnapshotRow } from '../domain/recordings.js';
import {
  DEFAULT_REPLAY_LIMITS,
  retainedBytes,
  checkReplaySize,
} from '../domain/replay-limits.js';
import { findTable, rowKey } from '../domain/schema.js';
import { boundedArray, objectFields, utf8Bytes } from '../domain/validation.js';
import type { RecordingExport } from '../ports/export.js';
import type { HistoryRange } from './resolve-history-range.js';
import type { ScanWork } from './scan-work.js';

async function* pages(
  history: RecordingExport,
  kind: 'baseline' | 'transactions',
  work: ScanWork,
): AsyncGenerator<unknown> {
  let cursor: string | null = null;
  const limit = kind === 'baseline' ? 100 : 1;
  do {
    work.check();
    const data = objectFields(await history[kind]({ cursor, limit }), [
      'items',
      'nextCursor',
    ]);
    work.check();
    const items = boundedArray(data.items, limit);
    const next = decodePageRequest({ cursor: data.nextCursor, limit }).cursor;
    if (next !== null && (next === cursor || items.length === 0))
      throw new HistoryError(
        'INVALID_HISTORY',
        'Scan history pagination did not advance.',
      );
    yield* items;
    cursor = next;
    await work.cooperate();
  } while (cursor !== null);
}

/** Holds a bounded immutable state/predecessor pair and one committed transaction. */
export async function* scanStates(
  history: RecordingExport,
  range: HistoryRange,
  work: ScanWork,
): AsyncGenerator<{
  readonly state: HistoryState;
  readonly previous: HistoryState | null;
  readonly transaction: CommittedTransaction | null;
}> {
  const info = history.info;
  const rows: SnapshotRow[] = [];
  let bytes = 0;
  for await (const input of pages(history, 'baseline', work)) {
    const entry = decodeSnapshotRow(info.recording, input);
    const key = rowKey(
      info.recording,
      findTable(info.recording.schema, entry.tableId),
      entry.row,
    );
    const size = retainedBytes(key, entry.row);
    bytes += size;
    checkReplaySize(DEFAULT_REPLAY_LIMITS, rows.length + 1, bytes);
    work.addBytes(size);
    rows.push(entry);
    if (rows.length > (info.baselineRowCount ?? 0))
      throw new HistoryError(
        'INVALID_HISTORY',
        'Scan baseline exceeds declared row count.',
      );
    if (size >= 16384 || rows.length % 64 === 0) await work.cooperate();
  }
  if (rows.length !== info.baselineRowCount)
    throw new HistoryError('INVALID_HISTORY', 'Scan baseline is incomplete.');
  let state = HistoryState.fromSnapshot(
    info.recording,
    info.baselinePosition,
    rows,
  );
  rows.length = 0;
  await work.cooperate();
  if (state.position === range.from)
    yield { state, previous: null, transaction: null };
  if (state.position === range.to) return;
  for await (const input of pages(history, 'transactions', work)) {
    if (work.replayedTransactions >= work.limits.maxTransactions)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Invariant scan exceeds its transaction budget.',
      );
    const transaction = decodeTransaction(info.recording, input);
    if (
      transaction.previousPosition !== state.position ||
      comparePositions(transaction.position, range.to) > 0
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Scan history does not cover the selected range.',
      );
    if (transaction.events.length > work.limits.maxEvents - work.events)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Invariant scan exceeds its event budget.',
      );
    work.addBytes(
      utf8Bytes(JSON.stringify(transaction), TRANSACTION_LIMITS.maxBytes),
    );
    const previous = state;
    state = state.apply(transaction);
    work.replayedTransactions++;
    work.events += transaction.events.length;
    await work.cooperate();
    if (comparePositions(state.position, range.from) >= 0)
      yield { state, previous, transaction };
    if (state.position === range.to) return;
  }
  throw new HistoryError(
    'INVALID_HISTORY',
    'Scan history ended before the selected boundary.',
  );
}
