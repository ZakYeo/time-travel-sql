import { HistoryError } from '../domain/errors.js';
import { decodeRecordingInfo } from '../domain/recordings.js';
import { decodePosition } from '../domain/position.js';
import { decodeRowHistoryOptions } from '../domain/row-history.js';
import type {
  RowHistoryOptions,
  RowHistoryEntry,
} from '../domain/row-history.js';
import { decodeSelection } from '../domain/selection.js';
import type { Selection } from '../domain/selection.js';
import { findTable, rowKey } from '../domain/schema.js';
import {
  boundedText,
  identityText,
  objectFields,
  utf8Bytes,
} from '../domain/validation.js';
import type { RecordingExport } from '../ports/export.js';
import { InvestigationPage } from './investigation-work.js';
import type { InvestigationControl } from './investigation-work.js';
import { resolveHistoryRange } from './resolve-history-range.js';
import { replayHistory } from './replay-history.js';
import { resolveRowOrigin } from './row-origin.js';
import { RowHistoryWork } from './row-history-work.js';

export interface RowHistoryRequest {
  readonly tableId: string;
  readonly key: string;
  readonly selection: Selection;
  readonly options?: Partial<RowHistoryOptions>;
}

/** Two bounded passes over one borrowed immutable history. Updates preserve row
 * identity; delete/insert reuse never does. Full coverage is validated after paging.
 * Open the borrowed history with control.signal to interrupt pending port reads.
 */
export async function inspectRowHistory(
  history: RecordingExport,
  request: RowHistoryRequest,
  control: InvestigationControl,
) {
  const data = objectFields(request, [
    'tableId',
    'key',
    'selection',
    'options',
  ]);
  const tableId = identityText(data.tableId);
  const key = boundedText(data.key, 65536);
  const options = decodeRowHistoryOptions(data.options);
  const work = new RowHistoryWork(options, control);
  work.addBytes(utf8Bytes(key, 65536));
  const info = decodeRecordingInfo(history.info);
  const pinned: RecordingExport = {
    info,
    baseline: (page) => history.baseline(page),
    transactions: (page) => history.transactions(page),
    transaction: (position) => history.transaction(position),
    close: () => history.close(),
  };
  const table = findTable(info.recording.schema, tableId);
  const anchor = await resolveHistoryRange(
    pinned,
    { kind: 'baseline' },
    decodeSelection(data.selection),
    control.signal,
  );
  const origin = await resolveRowOrigin(pinned, anchor, tableId, key, work);
  const range = Object.freeze({
    from: anchor.from,
    to: decodePosition(info.headPosition),
  });
  const page = new InvestigationPage<RowHistoryEntry>(options);
  let liveKey: string | null = null;
  let born = false;
  let anchored = false;
  for await (const { state, transaction } of replayHistory(
    pinned,
    range,
    work,
  )) {
    if (!transaction && origin.kind === 'baseline') {
      const row = state.row(tableId, origin.key);
      if (!row)
        throw new HistoryError(
          'INVALID_HISTORY',
          'Row origin is absent from the baseline.',
        );
      born = true;
      liveKey = origin.key;
      page.add(
        Object.freeze({
          kind: 'baseline',
          position: state.position,
          transactionId: null,
          eventIndex: null,
          committedAtMicros: null,
          beforeKey: null,
          afterKey: liveKey,
          before: null,
          after: row,
        }),
      );
    }
    if (transaction) {
      for (const [eventIndex, event] of transaction.events.entries()) {
        if (eventIndex % 64 === 0) await work.cooperate();
        if (event.tableId !== tableId) continue;
        const beforeKey =
          event.kind === 'insert'
            ? null
            : rowKey(info.recording, table, event.before);
        const starts =
          origin.kind === 'insert' &&
          transaction.position === origin.position &&
          eventIndex === origin.eventIndex;
        if (!starts && (liveKey === null || beforeKey !== liveKey)) continue;
        if (starts) {
          if (born || event.kind !== 'insert')
            throw new HistoryError(
              'INVALID_HISTORY',
              'Invalid row insertion origin.',
            );
          born = true;
        }
        liveKey =
          event.kind === 'delete'
            ? null
            : rowKey(info.recording, table, event.after);
        page.add(
          Object.freeze({
            kind: event.kind,
            position: transaction.position,
            transactionId: transaction.id,
            eventIndex,
            committedAtMicros: transaction.committedAtMicros ?? null,
            beforeKey,
            afterKey: liveKey,
            before: event.kind === 'insert' ? null : event.before,
            after: event.kind === 'delete' ? null : event.after,
          }),
        );
      }
    }
    if (state.position === anchor.to) {
      if (liveKey !== key || !state.row(tableId, key))
        throw new HistoryError(
          'INVALID_HISTORY',
          'Row lineage differs at the selected anchor.',
        );
      anchored = true;
    }
  }
  work.check();
  if (!born || !anchored)
    throw new HistoryError('INVALID_HISTORY', 'Row history is incomplete.');
  return Object.freeze({
    recording: info,
    tableId,
    anchor: Object.freeze({ position: anchor.to, key }),
    origin,
    range,
    status: liveKey === null ? ('deleted' as const) : ('present' as const),
    currentKey: liveKey,
    options,
    work: Object.freeze({
      replayedTransactions: work.replayedTransactions,
      events: work.events,
      inputBytes: work.inputBytes,
    }),
    ...page.result(),
  });
}
