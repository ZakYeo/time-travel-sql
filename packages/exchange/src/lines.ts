import { TextDecoder } from 'node:util';
import { HistoryError } from '@time-travel-sql/sdk';
import type { ExchangeLimits } from './limits.js';
import { checkCancelled } from './limits.js';
import { CooperativeWork } from './cooperative-work.js';

/** A single bounded reusable buffer avoids quadratic copying of tiny chunks. */
export async function* recordingLines(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  limits: ExchangeLimits,
): AsyncGenerator<{ readonly bytes: Uint8Array; readonly text: string }> {
  const pending = new Uint8Array(
    Math.min(limits.maxRecordBytes, limits.maxTotalBytes),
  );
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const work = new CooperativeWork(signal);
  let length = 0;
  let total = 0;
  checkCancelled(signal);
  for await (const chunk of source) {
    checkCancelled(signal);
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0)
      throw new HistoryError(
        'INVALID_VALUE',
        'Recording input must contain nonempty byte chunks.',
      );
    total += chunk.byteLength;
    if (total > limits.maxTotalBytes)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Recording exceeds its total byte budget.',
      );
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const size = end - offset;
      if (length + size > pending.length)
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'Recording exceeds its record byte budget.',
        );
      pending.set(chunk.subarray(offset, end), length);
      length += size;
      offset = end + 1;
      await work.advance(size + (newline === -1 ? 0 : 1));
      if (newline === -1) continue;
      if (length === 0)
        throw new HistoryError('INVALID_HISTORY', 'Empty recording line.');
      const bytes = pending.subarray(0, length);
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch (cause) {
        throw new HistoryError(
          'INVALID_HISTORY',
          'Recording contains invalid UTF-8.',
          { cause },
        );
      }
      yield { bytes, text };
      checkCancelled(signal);
      length = 0;
    }
  }
  checkCancelled(signal);
  if (length !== 0)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recording is missing its final newline.',
    );
}
