import { isAbsolute } from 'node:path';
import {
  HistoryError,
  decodeRecordingInfo,
  decodeStableId,
  decodeReplayLimits,
  DEFAULT_REPLAY_LIMITS,
} from '@time-travel-sql/sdk';
import type { HistoryExports } from '@time-travel-sql/sdk';
import type { LocalReconstructionOptions } from './reconstructor.js';
import { ReadWorkers } from './read-workers.js';

export type LocalExportOptions = LocalReconstructionOptions;

/** Holds read-only SQLite snapshots until each export session is closed. */
export function createLocalExporter(
  options: LocalExportOptions,
): HistoryExports {
  if (typeof options.path !== 'string' || !isAbsolute(options.path))
    throw new HistoryError(
      'INVALID_VALUE',
      'Export requires an absolute file path.',
    );
  const workerOptions = {
    path: options.path,
    replayLimits: decodeReplayLimits(
      options.replayLimits ?? DEFAULT_REPLAY_LIMITS,
    ),
  };
  const workers = new ReadWorkers(options.maxConcurrent ?? 2);
  return {
    async open(input, signal) {
      const id = decodeStableId(input);
      const session = await workers.open(
        { kind: 'export', options: workerOptions, recordingId: id },
        signal,
      );
      try {
        const info = decodeRecordingInfo(session.ready);
        return {
          info,
          baseline: async (page) => {
            session.checkOpen();
            return session.client.request({
              method: 'baseline',
              args: [id, page],
            });
          },
          transactions: async (page) => {
            session.checkOpen();
            return session.client.request({
              method: 'transactions',
              args: [id, page],
            });
          },
          transaction: async (position) => {
            session.checkOpen();
            return session.client.request({
              method: 'transaction',
              args: [id, position],
            });
          },
          close: session.close,
        };
      } catch (error) {
        await session.close();
        throw error;
      }
    },
    close: () => workers.close(),
  };
}
