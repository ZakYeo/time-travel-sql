import { HistoryError } from '../domain/errors.js';
import { decodePageRequest } from '../domain/recordings.js';
import type { RecordingInfo } from '../domain/recordings.js';
import { decodePosition } from '../domain/position.js';
import { decodeReconstructionInfo } from '../domain/reconstruction.js';
import type { HistoryState } from '../domain/state.js';
import type { Row } from '../domain/schema.js';
import type { ReconstructionView } from '../ports/reconstruction.js';

export function scanView(
  recording: RecordingInfo,
  state: HistoryState,
): ReconstructionView {
  const tables = new Map<string, readonly Row[]>();
  return {
    info: decodeReconstructionInfo({
      recording,
      position: state.position,
      selection:
        state.position === recording.baselinePosition
          ? { kind: 'baseline' }
          : { kind: 'after', position: state.position },
      rowCount: state.rowCount,
      retainedBytes: state.retainedBytes,
      limits: state.limits,
    }),
    rows: async (table, input) => {
      const page = decodePageRequest(input);
      let rows = tables.get(table);
      if (!rows) {
        rows = state.rows(table);
        tables.set(table, rows);
      }
      const start =
        page.cursor === null ? 0n : BigInt(decodePosition(page.cursor));
      if (start > BigInt(rows.length))
        throw new HistoryError(
          'INVALID_VALUE',
          'Scan cursor is outside the selected table.',
        );
      const offset = Number(start);
      const items = rows.slice(offset, offset + page.limit);
      const end = offset + items.length;
      return { items, nextCursor: end < rows.length ? String(end) : null };
    },
  };
}
