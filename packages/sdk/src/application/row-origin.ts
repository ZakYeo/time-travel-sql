import { HistoryError } from '../domain/errors.js';
import { findTable, rowKey } from '../domain/schema.js';
import type { RowOrigin } from '../domain/row-history.js';
import { utf8Bytes } from '../domain/validation.js';
import type { RecordingExport } from '../ports/export.js';
import type { HistoryRange } from './resolve-history-range.js';
import { replayHistory } from './replay-history.js';
import type { RowHistoryWork } from './row-history-work.js';

/** Only changed live keys need a map: untouched rows retain their baseline origin. */
export async function resolveRowOrigin(
  history: RecordingExport,
  range: HistoryRange,
  tableId: string,
  key: string,
  work: RowHistoryWork,
): Promise<RowOrigin> {
  const recording = history.info.recording;
  const table = findTable(recording.schema, tableId);
  const origins = new Map<string, RowOrigin>();
  for await (const { state, transaction } of replayHistory(
    history,
    range,
    work,
  )) {
    if (transaction) {
      for (const [eventIndex, event] of transaction.events.entries()) {
        if (eventIndex % 64 === 0) await work.cooperate();
        if (event.tableId !== tableId) continue;
        let origin: RowOrigin;
        if (event.kind === 'insert')
          origin = {
            kind: 'insert',
            position: transaction.position,
            eventIndex,
          };
        else {
          const before = rowKey(recording, table, event.before);
          origin = origins.get(before) ?? { kind: 'baseline', key: before };
          origins.delete(before);
        }
        if (event.kind !== 'delete') {
          const after = rowKey(recording, table, event.after);
          work.addBytes(
            utf8Bytes(after, 65536) +
              utf8Bytes(JSON.stringify(origin), 262144) +
              64,
          );
          origins.set(after, origin);
        }
      }
    }
    if (state.position === range.to) {
      if (!state.row(tableId, key))
        throw new HistoryError(
          'INVALID_VALUE',
          'The selected row is absent at the anchor state.',
        );
      return Object.freeze(origins.get(key) ?? { kind: 'baseline', key });
    }
  }
  throw new HistoryError(
    'INVALID_HISTORY',
    'Row history skipped its anchor state.',
  );
}
