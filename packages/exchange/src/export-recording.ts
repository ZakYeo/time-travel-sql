import {
  decodeDataFields,
  decodeDataArray,
  decodePageRequest,
  HistoryError,
} from '@time-travel-sql/sdk';
import type { RecordingExport } from '@time-travel-sql/sdk';
import { encodeRecordingFrames } from './stream.js';
import type { ExchangeLimits } from './limits.js';
import {
  checkCancelled,
  exchangeLimits,
  DEFAULT_EXCHANGE_LIMITS,
} from './limits.js';
import { manifestFor } from './manifest.js';
import { RecordingValidation } from './recording-validation.js';

async function* records(
  session: RecordingExport,
  signal: AbortSignal,
  limits: ExchangeLimits,
): AsyncGenerator<string> {
  checkCancelled(signal);
  const manifest = manifestFor(session.info, limits.maxRecords);
  const validation = new RecordingValidation(manifest);
  yield JSON.stringify(manifest);
  for (const kind of ['baseline', 'transaction'] as const) {
    let cursor: string | null = null;
    do {
      checkCancelled(signal);
      const request = { cursor, limit: 100 };
      const input: unknown =
        kind === 'baseline'
          ? await session.baseline(request)
          : await session.transactions(request);
      const page = decodeDataFields(input, ['items', 'nextCursor']);
      const items = decodeDataArray(page.items, 100);
      const next = decodePageRequest({
        cursor: page.nextCursor,
        limit: 100,
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
        yield JSON.stringify(record);
      }
      cursor = next;
    } while (cursor !== null);
    if (kind === 'baseline') validation.finishBaseline();
  }
  validation.finish();
}

/** Caller owns the pinned session and must close it, including before first next(). */
export function exportRecording(
  session: RecordingExport,
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
