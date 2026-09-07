import { HistoryError } from '../domain/errors.js';
import { decodeReconstructionInfo } from '../domain/reconstruction.js';
import { decodeRow, rowKey } from '../domain/schema.js';
import { retainedBytes } from '../domain/replay-limits.js';
import {
  boundedArray,
  boundedText,
  objectFields,
} from '../domain/validation.js';
import type { SnapshotRow } from '../domain/recordings.js';
import type { ReconstructionView } from '../ports/reconstruction.js';

/** Staged consumers publish only after completion. The caller retains session ownership. */
export async function* reconstructionRows(
  session: ReconstructionView,
): AsyncIterable<SnapshotRow> {
  const info = decodeReconstructionInfo(session.info);
  const recording = info.recording.recording;
  let count = 0;
  let bytes = 0;
  for (const table of recording.schema.tables) {
    let cursor: string | null = null;
    let previousKey: string | undefined;
    do {
      const page = objectFields(
        await session.rows(table.id, { cursor, limit: 100 }),
        ['items', 'nextCursor'],
      );
      const items = boundedArray(page.items, 100);
      const next =
        page.nextCursor === null ? null : boundedText(page.nextCursor, 65536);
      if (next !== null && (next === cursor || items.length === 0))
        throw new HistoryError(
          'INVALID_HISTORY',
          'Reconstruction pagination made no progress.',
        );
      for (const input of items) {
        const row = decodeRow(table, input);
        const key = rowKey(recording, table, row);
        if (previousKey !== undefined && key <= previousKey)
          throw new HistoryError(
            'INVALID_HISTORY',
            'Reconstructed rows are duplicated or out of order.',
          );
        previousKey = key;
        count++;
        bytes += retainedBytes(key, row);
        if (count > info.rowCount || bytes > info.retainedBytes)
          throw new HistoryError(
            'INVALID_HISTORY',
            'Reconstructed rows exceed declared state size.',
          );
        yield Object.freeze({ tableId: table.id, row });
      }
      cursor = next;
    } while (cursor !== null);
  }
  if (count !== info.rowCount || bytes !== info.retainedBytes)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Reconstructed rows do not match declared state size.',
    );
}
