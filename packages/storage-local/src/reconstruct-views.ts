import {
  HistoryError,
  decodeReconstructionRequest,
  decodeReconstructionInfo,
  decodeReplayLimits,
  DEFAULT_REPLAY_LIMITS,
  selectedPosition,
  decodeDataArray,
} from '@time-travel-sql/sdk';
import type { Row, ReconstructionInfo } from '@time-travel-sql/sdk';
import { openReadSnapshot } from './database.js';
import { Reader } from './reader.js';
import { Checkpoints } from './checkpoints.js';
import type { Startup } from './protocol.js';

export function reconstructViews(
  startup: Extract<Startup, { kind: 'reconstruction' }>,
): {
  info: ReconstructionInfo;
  tables: ReadonlyMap<string, readonly Row[]>;
}[] {
  const requests = decodeDataArray(startup.requests, 2).map(
    decodeReconstructionRequest,
  );
  if (
    !requests.length ||
    requests.some((request) => request.recordingId !== requests[0]?.recordingId)
  )
    throw new HistoryError(
      'INVALID_VALUE',
      'Reconstruction views require one recording.',
    );
  const limits = decodeReplayLimits(
    startup.options.replayLimits ?? DEFAULT_REPLAY_LIMITS,
  );
  const db = openReadSnapshot(startup.options.path);
  try {
    const reader = new Reader(db);
    const snapshots = requests.map((request) => {
      const recording = reader.published(request.recordingId);
      const position = selectedPosition(
        recording,
        request.selection,
        request.selection.kind === 'baseline'
          ? undefined
          : reader.transaction(recording.id, request.selection.position),
      );
      const state = new Checkpoints(reader, limits).restore(
        recording,
        position,
      );
      const info = decodeReconstructionInfo({
        recording,
        selection: request.selection,
        position: state.position,
        rowCount: state.rowCount,
        retainedBytes: state.retainedBytes,
        limits: state.limits,
      });
      const tables = new Map(
        recording.recording.schema.tables.map((table) => [
          table.id,
          state.rows(table.id),
        ]),
      );
      return { info, tables };
    });
    db.exec('COMMIT');
    return snapshots;
  } finally {
    db.close();
  }
}
