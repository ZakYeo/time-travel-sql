import { createHash } from 'node:crypto';
import { HistoryError } from '@time-travel-sql/sdk';
import type { ExchangeLimits } from './limits.js';
import {
  DEFAULT_EXCHANGE_LIMITS,
  exchangeLimits,
  checkCancelled,
} from './limits.js';
import { recordingLines } from './lines.js';
import { parseRecord } from './json-record.js';
import { CooperativeWork } from './cooperative-work.js';

const HEADER = '{"format":"time-travel-sql-frames","version":1}';
const LF = new Uint8Array([10]);

/** Values remain untrusted until domain validation AND normal stream completion.
 * The source owns cancellation of pending I/O and must observe the supplied signal.
 */
export async function* decodeRecordingFrames(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  options: ExchangeLimits = DEFAULT_EXCHANGE_LIMITS,
): AsyncGenerator<unknown> {
  const limits = exchangeLimits(options);
  const hash = createHash('sha256');
  let state: 'header' | 'records' | 'complete' = 'header';
  let records = 0;
  for await (const { bytes, text } of recordingLines(source, signal, limits)) {
    if (state === 'complete')
      throw new HistoryError(
        'INVALID_HISTORY',
        'Data follows the recording trailer.',
      );
    const frame = parseRecord(text, limits);
    if (state === 'header') {
      if (text !== HEADER)
        throw new HistoryError(
          'INVALID_HISTORY',
          'Unsupported recording framing version.',
        );
      state = 'records';
    } else {
      if (typeof frame !== 'object' || frame === null || Array.isArray(frame))
        throw new HistoryError('INVALID_HISTORY', 'Invalid recording frame.');
      if ('end' in frame) {
        const expected = JSON.stringify({
          end: records,
          sha256: hash.digest('hex'),
        });
        if (text !== expected)
          throw new HistoryError(
            'INVALID_HISTORY',
            'Recording checksum or count mismatch.',
          );
        state = 'complete';
        continue;
      }
      if (Object.keys(frame).length !== 1 || !('record' in frame))
        throw new HistoryError(
          'INVALID_HISTORY',
          'Invalid recording data frame.',
        );
      if (++records > limits.maxRecords)
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'Recording exceeds its record count budget.',
        );
      hash.update(bytes).update(LF);
      yield frame.record;
      continue;
    }
    hash.update(bytes).update(LF);
  }
  if (state !== 'complete')
    throw new HistoryError('INVALID_HISTORY', 'Recording is incomplete.');
}

/** Encodes caller-validated canonical JSON text without invoking object getters/toJSON.
 * Domain validation and atomic publication belong to the recording import service.
 */
export async function* encodeRecordingFrames(
  records: AsyncIterable<string>,
  signal: AbortSignal,
  options: ExchangeLimits = DEFAULT_EXCHANGE_LIMITS,
): AsyncGenerator<Uint8Array> {
  const limits = exchangeLimits(options);
  const hash = createHash('sha256');
  let total = 0;
  let count = 0;
  const work = new CooperativeWork(signal);
  const line = (text: string): Uint8Array => {
    checkCancelled(signal);
    if (
      typeof text !== 'string' ||
      text.length > limits.maxRecordBytes ||
      !text.isWellFormed()
    )
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Recording exceeds its record text budget.',
      );
    const bytes = Buffer.from(text + '\n', 'utf8');
    total += bytes.length;
    if (
      bytes.length - 1 > limits.maxRecordBytes ||
      total > limits.maxTotalBytes
    )
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Recording exceeds its byte budget.',
      );
    parseRecord(text, limits);
    return bytes;
  };
  const header = line(HEADER);
  hash.update(header);
  yield header;
  checkCancelled(signal);
  for await (const record of records) {
    checkCancelled(signal);
    if (++count > limits.maxRecords)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Recording exceeds its record count budget.',
      );
    if (typeof record !== 'string' || record.length > limits.maxRecordBytes)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Recording exceeds its record text budget.',
      );
    parseRecord(record, limits);
    const bytes = line('{"record":' + record + '}');
    hash.update(bytes);
    await work.advance(bytes.length);
    yield bytes;
    checkCancelled(signal);
  }
  yield line(JSON.stringify({ end: count, sha256: hash.digest('hex') }));
}
