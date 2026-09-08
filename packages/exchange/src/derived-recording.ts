import {
  applyColumnPolicy,
  decodeRecordingMetadata,
  decodeRecordingInfo,
  DERIVED_CAPABILITIES,
  HistoryError,
  HistoryState,
  projectRow,
  projectTransaction,
} from '@time-travel-sql/sdk';
import type {
  ColumnPolicy,
  RecordingExportView,
  SnapshotRow,
} from '@time-travel-sql/sdk';
import { manifestFor } from './manifest.js';
import { recordingRecords } from './export-recording.js';
import { BaselineCommitment } from './baseline-commitment.js';
import { CooperativeWork } from './cooperative-work.js';
import { borrowedRead } from './borrowed-read.js';
import {
  checkCancelled,
  exchangeLimits,
  DEFAULT_EXCHANGE_LIMITS,
} from './limits.js';
import type { ExchangeLimits } from './limits.js';

export interface DerivedRecordingOptions {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly columnPolicy: ColumnPolicy;
}

/** Validate all original replay before projection; caller owns and closes the pinned source. */
export async function prepareDerivedRecording(
  source: RecordingExportView,
  options: DerivedRecordingOptions,
  signal: AbortSignal,
  inputLimits?: ExchangeLimits,
): Promise<RecordingExportView> {
  checkCancelled(signal);
  const limits = exchangeLimits(inputLimits ?? DEFAULT_EXCHANGE_LIMITS);
  const manifest = manifestFor(source.info, limits.maxRecords);
  const metadata = decodeRecordingMetadata({
    id: options.id,
    name: options.name,
    createdAt: options.createdAt,
    recording: {
      ...manifest.info.recording,
      schema: applyColumnPolicy(
        manifest.info.recording.schema,
        options.columnPolicy,
      ),
      derivation: {
        kind: 'column-policy',
        parentConfigurationFingerprint:
          manifest.captureConfigurationFingerprint,
        capabilities: DERIVED_CAPABILITIES,
        liveResume: false,
      },
    },
  });
  if (metadata.id === manifest.info.id)
    throw new HistoryError(
      'INVALID_VALUE',
      'Derived recording requires a distinct recording ID.',
    );
  const project = (row: SnapshotRow): SnapshotRow => ({
    tableId: row.tableId,
    row: projectRow(metadata.recording.schema, row.tableId, row.row),
  });
  const checksum = new BaselineCommitment(metadata.recording);
  const baseline = HistoryState.beginSnapshot(
    manifest.info.recording,
    manifest.info.baselinePosition,
  );
  let bytes = 0;
  let state: HistoryState | undefined;
  const work = new CooperativeWork(signal);
  for await (const record of recordingRecords(source, signal, limits)) {
    const size = Buffer.byteLength(JSON.stringify(record));
    bytes += size;
    if (size > limits.maxRecordBytes || bytes > limits.maxTotalBytes)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Derived export exceeds original history byte limits.',
      );
    await work.advance(size);
    if (record.kind === 'baseline') {
      baseline.add(record.row);
      checksum.add(project(record.row));
    } else if (record.kind === 'transaction') {
      state ??= baseline.finish();
      state = state.apply(record.transaction);
    }
  }
  // Also validate a baseline-only recording, including its keys and state budget.
  if (state === undefined) baseline.finish();
  checkCancelled(signal);
  const info = decodeRecordingInfo({
    ...manifest.info,
    ...metadata,
    baselineChecksum: checksum.finish(),
    status:
      manifest.info.status === 'recording'
        ? 'interrupted'
        : manifest.info.status,
  });
  return Object.freeze({
    info,
    baseline: async (page) => {
      checkCancelled(signal);
      const result = await borrowedRead(signal, () => source.baseline(page));
      return { ...result, items: result.items.map(project) };
    },
    transactions: async (page) => {
      checkCancelled(signal);
      const result = await borrowedRead(signal, () =>
        source.transactions(page),
      );
      return {
        ...result,
        items: result.items.map((tx) =>
          projectTransaction(manifest.info.recording, metadata.recording, tx),
        ),
      };
    },
    transaction: async (position) =>
      projectTransaction(
        manifest.info.recording,
        metadata.recording,
        await borrowedRead(signal, () => source.transaction(position)),
      ),
  } satisfies RecordingExportView);
}
