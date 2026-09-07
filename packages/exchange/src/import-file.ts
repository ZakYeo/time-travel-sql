import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { HistoryError } from '@time-travel-sql/sdk';
import type { HistoryImports, RecordingInfo } from '@time-travel-sql/sdk';
import { importRecording } from './import-recording.js';
import { recordingFilePath, fileFailures } from './file-support.js';
import {
  checkCancelled,
  exchangeLimits,
  DEFAULT_EXCHANGE_LIMITS,
} from './limits.js';
import type { ExchangeLimits } from './limits.js';

async function* fileChunks(
  path: string,
  signal: AbortSignal,
  limits: ExchangeLimits,
  errors: unknown[],
): AsyncGenerator<Uint8Array> {
  checkCancelled(signal);
  // O_NONBLOCK avoids waiting for a FIFO writer on platforms that support it.
  // The opened handle, rather than a racy pathname check, must be a regular file.
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile())
      throw new HistoryError(
        'INVALID_VALUE',
        'Recording input must be a regular file.',
      );
    if (stat.size > limits.maxTotalBytes)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Recording file exceeds its total byte budget.',
      );
    const buffer = Buffer.allocUnsafe(65536);
    while (true) {
      checkCancelled(signal);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      checkCancelled(signal);
      if (bytesRead === 0) break;
      yield buffer.subarray(0, bytesRead);
    }
  } catch (error) {
    errors.push(error);
    throw error;
  } finally {
    await file.close().catch((error: unknown) => {
      errors.push(error);
      throw error;
    });
  }
}

/** Owns lazy regular-file input and delegates verified EOF/atomic publication. */
export async function importRecordingFile(
  inputPath: string,
  destination: HistoryImports,
  signal: AbortSignal,
  inputLimits?: ExchangeLimits,
): Promise<RecordingInfo> {
  const path = recordingFilePath(inputPath);
  const limits = exchangeLimits(inputLimits ?? DEFAULT_EXCHANGE_LIMITS);
  checkCancelled(signal);
  const errors: unknown[] = [];
  try {
    return await importRecording(
      fileChunks(path, signal, limits, errors),
      destination,
      signal,
      limits,
    );
  } catch (error) {
    // AsyncIteratorClose can suppress a close rejection when its consumer
    // already failed. Retain owned I/O failures outside iterator propagation.
    if (!errors.includes(error)) errors.unshift(error);
    throw fileFailures(errors);
  }
}
