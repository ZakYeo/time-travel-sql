import { setImmediate } from 'node:timers/promises';
import {
  decodePosition,
  inspectReconstructedRows,
  compareReconstructedStates,
} from '@time-travel-sql/sdk';
import type { Selection } from '@time-travel-sql/sdk';
import {
  createLocalReconstructor,
  createLocalStatePairs,
} from '@time-travel-sql/storage-local';
import { UsageError } from './arguments.js';
import { owned } from './owned.js';

export function selection(value: string): Selection {
  if (value === 'baseline') return { kind: 'baseline' };
  const match = /^(before|after):([0-9]+)$/.exec(value);
  if (!match || (match[1] !== 'before' && match[1] !== 'after'))
    throw new UsageError('Select baseline, before:POSITION or after:POSITION.');
  return { kind: match[1], position: decodePosition(match[2]) };
}

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
