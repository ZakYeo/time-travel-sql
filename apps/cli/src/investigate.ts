import { setImmediate } from 'node:timers/promises';
import {
  inspectReconstructedRows,
  compareReconstructedStates,
} from '@time-travel-sql/sdk';
import {
  createLocalReconstructor,
  createLocalStatePairs,
} from '@time-travel-sql/storage-local';
import { selection } from './selection.js';
import { owned } from './owned.js';

export async function investigate(
  path: string,
  command: 'rows' | 'compare',
  operands: readonly string[],
  options: { limit?: string; offset?: string },
  signal: AbortSignal,
) {
  const [recordingId = '', tableId = '', from = '', to = ''] = operands;
  const request = {
    tableId,
    limit: Number(options.limit ?? '50'),
    offset: Number(options.offset ?? '0'),
  };
  const control = {
    signal,
    cooperate: async () => {
      await setImmediate();
    },
  };
  const start = { recordingId, selection: selection(from) };
  if (command === 'rows')
    return owned(createLocalReconstructor({ path }), async (provider) =>
      owned(await provider.open(start, signal), (view) =>
        inspectReconstructedRows(view, request, control),
      ),
    );
  const end = { recordingId, selection: selection(to) };
  return owned(createLocalStatePairs({ path }), async (provider) =>
    owned(await provider.open(start, end, signal), (pair) =>
      compareReconstructedStates(pair, request, control),
    ),
  );
}
