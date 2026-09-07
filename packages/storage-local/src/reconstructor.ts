import { isAbsolute } from 'node:path';
import {
  HistoryError,
  decodeReconstructionRequest,
  decodeReconstructionInfo,
  decodeDataArray,
  decodeReplayLimits,
  DEFAULT_REPLAY_LIMITS,
} from '@time-travel-sql/sdk';
import type {
  HistoryReconstructor,
  HistoryStatePairs,
  ReconstructionRequest,
  ReconstructionView,
  ReplayLimits,
  CancellationSignal,
} from '@time-travel-sql/sdk';
import { ReadWorkers } from './read-workers.js';

export interface LocalReconstructionOptions {
  readonly path: string;
  readonly replayLimits?: ReplayLimits;
  /** Maximum simultaneously owned workers, including pending opens. Defaults to 2. */
  readonly maxConcurrent?: number;
}

function reconstructionViews(options: LocalReconstructionOptions) {
  if (typeof options.path !== 'string' || !isAbsolute(options.path))
    throw new HistoryError(
      'INVALID_VALUE',
      'Reconstruction requires an absolute file path.',
    );
  const workerOptions = {
    path: options.path,
    replayLimits: decodeReplayLimits(
      options.replayLimits ?? DEFAULT_REPLAY_LIMITS,
    ),
  };
  const workers = new ReadWorkers(options.maxConcurrent ?? 2);
  return {
    async open(
      inputs: readonly ReconstructionRequest[],
      signal?: CancellationSignal,
    ) {
      const requests = inputs.map(decodeReconstructionRequest);
      if (
        requests.some(
          (request) => request.recordingId !== requests[0]?.recordingId,
        )
      )
        throw new HistoryError(
          'INVALID_VALUE',
          'Reconstruction views require one recording.',
        );
      const session = await workers.open(
        { kind: 'reconstruction', options: workerOptions, requests },
        signal,
      );
      try {
        const infos = decodeDataArray(session.ready, requests.length).map(
          decodeReconstructionInfo,
        );
        if (infos.length !== requests.length)
          throw new HistoryError(
            'INVALID_HISTORY',
            'Missing reconstruction view.',
          );
        const views: ReconstructionView[] = infos.map((info, view) => ({
          info,
          rows: async (tableId, page) => {
            session.checkOpen();
            return session.client.request({
              method: 'reconstructionRows',
              args: [view, tableId, page],
            });
          },
        }));
        return { views, close: session.close };
      } catch (error) {
        await session.close();
        throw error;
      }
    },
    close: () => workers.close(),
  };
}

export function createLocalReconstructor(
  options: LocalReconstructionOptions,
): HistoryReconstructor {
  const provider = reconstructionViews(options);
  return {
    async open(request, signal) {
      const session = await provider.open([request], signal);
      const view = session.views[0];
      if (!view) {
        await session.close();
        throw new HistoryError(
          'INVALID_HISTORY',
          'Missing reconstruction view.',
        );
      }
      return { ...view, close: session.close };
    },
    close: provider.close,
  };
}

/** Both committed states are reconstructed in one SQLite read transaction. */
export function createLocalStatePairs(
  options: LocalReconstructionOptions,
): HistoryStatePairs {
  const provider = reconstructionViews(options);
  return {
    async open(from, to, signal) {
      const session = await provider.open([from, to], signal);
      const [left, right] = session.views;
      if (!left || !right) {
        await session.close();
        throw new HistoryError(
          'INVALID_HISTORY',
          'Missing reconstruction pair.',
        );
      }
      return { from: left, to: right, close: session.close };
    },
    close: provider.close,
  };
}
