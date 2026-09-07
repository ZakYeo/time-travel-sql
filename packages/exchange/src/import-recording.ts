import { HistoryError } from '@time-travel-sql/sdk';
import type {
  HistoryImports,
  RecordingImport,
  RecordingInfo,
  SnapshotRow,
} from '@time-travel-sql/sdk';
import { decodeRecordingFrames } from './stream.js';
import type { ExchangeLimits } from './limits.js';
import {
  checkCancelled,
  exchangeLimits,
  DEFAULT_EXCHANGE_LIMITS,
} from './limits.js';
import { verifiedManifest } from './manifest.js';
import { RecordingValidation } from './recording-validation.js';

/** Owns input iteration and staging; publication occurs only after verified EOF. */
export async function importRecording(
  source: AsyncIterable<Uint8Array>,
  destination: HistoryImports,
  signal: AbortSignal,
  limits?: ExchangeLimits,
): Promise<RecordingInfo> {
  const options = exchangeLimits(limits ?? DEFAULT_EXCHANGE_LIMITS);
  let stage: RecordingImport | undefined;
  let validation: RecordingValidation | undefined;
  let baselinePublished = false;
  let batch: SnapshotRow[] = [];
  let batchBytes = 0;
  let result: RecordingInfo | undefined;
  const errors: unknown[] = [];
  const flush = async () => {
    if (stage && batch.length) await stage.stageBaseline(batch);
    batch = [];
    batchBytes = 0;
  };
  const finishBaseline = async () => {
    if (!stage || !validation || baselinePublished) return;
    validation.finishBaseline();
    await flush();
    checkCancelled(signal);
    await stage.publishBaseline(validation.manifest.info.baselinePosition);
    baselinePublished = true;
  };
  try {
    for await (const input of decodeRecordingFrames(source, signal, options)) {
      checkCancelled(signal);
      if (!validation) {
        const manifest = verifiedManifest(input, options.maxRecords);
        validation = new RecordingValidation(manifest);
        const { id, name, createdAt, recording } = manifest.info;
        stage = await destination.beginImport(
          { id, name, createdAt, recording },
          signal,
        );
        continue;
      }
      const record = validation.accept(input);
      if (record.kind === 'baseline') {
        const size = Buffer.byteLength(JSON.stringify(record.row));
        if (batch.length === 100 || batchBytes + size > 16 * 1024 * 1024)
          await flush();
        batch.push(record.row);
        batchBytes += size;
      } else {
        await finishBaseline();
        if (!stage)
          throw new HistoryError('INVALID_HISTORY', 'Missing import stage.');
        await stage.append(record.transaction);
      }
    }
    if (!stage || !validation)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Recording manifest is missing.',
      );
    validation.finish();
    await finishBaseline();
    checkCancelled(signal);
    const info = validation.manifest.info;
    result = await stage.publish({
      ...info,
      status: info.status === 'recording' ? 'interrupted' : info.status,
    });
  } catch (error) {
    errors.push(error);
  }
  if (stage) {
    try {
      await stage.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Recording import and cleanup failed.');
  if (!result)
    throw new HistoryError(
      'INVALID_HISTORY',
      'Recording import produced no result.',
    );
  return result;
}
