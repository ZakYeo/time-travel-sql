import {
  decodeDataFields,
  decodeDataArray,
  decodePageRequest,
  HistoryError,
} from '@time-travel-sql/sdk';
import type { RecordingExportView } from '@time-travel-sql/sdk';
import type { RecordingManifest } from '@time-travel-sql/sdk';
import { encodeRecordingFrames } from './stream.js';
import type { ExchangeLimits } from './limits.js';
import {
  checkCancelled,
  exchangeLimits,
  DEFAULT_EXCHANGE_LIMITS,
} from './limits.js';
import { manifestFor } from './manifest.js';
import { RecordingValidation } from './recording-validation.js';
import { borrowedRead } from './borrowed-read.js';
import type { DataRecord } from './recording-validation.js';

export async function* recordingRecords(
  session: RecordingExportView,
  signal: AbortSignal,
  limits: ExchangeLimits,
): AsyncGenerator<RecordingManifest | DataRecord> {
  checkCancelled(signal);
  const manifest = manifestFor(session.info, limits.maxRecords);
  const validation = new RecordingValidation(manifest);
  yield manifest;
  for (const kind of ['baseline', 'transaction'] as const) {
    const limit = kind === 'baseline' ? 100 : 1;
    let cursor: string | null = null;
    do {
      checkCancelled(signal);
      const request = { cursor, limit };
      const input: unknown =
        kind === 'baseline'
          ? await borrowedRead(signal, () => session.baseline(request))
          : await borrowedRead(signal, () => session.transactions(request));
      const page = decodeDataFields(input, ['items', 'nextCursor']);
      const items = decodeDataArray(page.items, limit);
      const next = decodePageRequest({
        cursor: page.nextCursor,
        limit,
      }).cursor;
      if (next !== null && (next === cursor || items.length === 0))
        throw new HistoryError(
          'INVALID_HISTORY',
          'Export page did not advance.',
        );
      for (const item of items) {
        checkCancelled(signal);
        const record = validation.accept(
          kind === 'baseline'
            ? { kind, row: item }
            : { kind, transaction: item },
        );
        yield record;
      }
      cursor = next;
    } while (cursor !== null);
    if (kind === 'baseline') validation.finishBaseline();
  }
  validation.finish();
}

async function* records(
  session: RecordingExportView,
  signal: AbortSignal,
  limits: ExchangeLimits,
) {
  for await (const record of recordingRecords(session, signal, limits))
    yield JSON.stringify(record);
}

/** Caller owns the pinned session and must close it, including before first next(). */
export function exportRecording(
  session: RecordingExportView,
  signal: AbortSignal,
  limits?: ExchangeLimits,
): AsyncGenerator<Uint8Array> {
  const options = exchangeLimits(limits ?? DEFAULT_EXCHANGE_LIMITS);
  return encodeRecordingFrames(
    records(session, signal, options),
    signal,
    options,
  );
}
