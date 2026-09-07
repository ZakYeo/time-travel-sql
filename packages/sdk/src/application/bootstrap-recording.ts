import { HistoryError } from '../domain/errors.js';
import { decodePosition } from '../domain/position.js';
import {
  decodeRecordingMetadata,
  decodeSnapshotRow,
} from '../domain/recordings.js';
import type { RecordingMetadata, RecordingInfo } from '../domain/recordings.js';
import { boundedArray, objectFields, utf8Bytes } from '../domain/validation.js';
import { findTable, rowKey, decodeRecordingSchema } from '../domain/schema.js';
import { decodeCaptureBinding } from '../domain/capture-binding.js';
import type { CaptureBinding } from '../domain/capture-binding.js';
import {
  DEFAULT_REPLAY_LIMITS,
  decodeReplayLimits,
  retainedBytes,
  checkReplaySize,
} from '../domain/replay-limits.js';
import type { ReplayLimits } from '../domain/replay-limits.js';
import type { SourceBaseline, SourceCapturePlan } from '../ports/source.js';
import type {
  HistoryWriter,
  HistoryCaptureBindings,
} from '../ports/history.js';

type BootstrapWriter = Pick<
  HistoryWriter,
  'create' | 'stageBaseline' | 'publishBaseline' | 'setStatus'
>;
type BootstrapSource =
  | { readonly kind: 'open'; readonly baseline: SourceBaseline }
  | {
      readonly kind: 'planned';
      readonly plan: SourceCapturePlan;
      readonly bind: (id: string, binding: CaptureBinding) => Promise<void>;
    };

/** Owns source closure. Failed staged artifacts stay invalid, never published.
 * The writer must reject duplicate keys and validate the full baseline on publication.
 */
export async function bootstrapRecording(
  source: SourceBaseline,
  writer: BootstrapWriter,
  input: Omit<RecordingMetadata, 'recording'>,
  limitsInput: ReplayLimits = DEFAULT_REPLAY_LIMITS,
): Promise<RecordingInfo> {
  return runBootstrap(
    { kind: 'open', baseline: source },
    writer,
    input,
    limitsInput,
  );
}

/** Persists metadata and binding before opening a source that allocates resources.
 * Does not resume a prior failed bootstrap or adopt an existing recording ID.
 */
export async function bootstrapBoundRecording(
  plan: SourceCapturePlan,
  writer: BootstrapWriter & Pick<HistoryCaptureBindings, 'bindCapture'>,
  input: Omit<RecordingMetadata, 'recording'>,
  limitsInput: ReplayLimits = DEFAULT_REPLAY_LIMITS,
): Promise<RecordingInfo> {
  return runBootstrap(
    {
      kind: 'planned',
      plan,
      bind: (id, binding) => writer.bindCapture(id, binding),
    },
    writer,
    input,
    limitsInput,
  );
}

async function runBootstrap(
  preparation: BootstrapSource,
  writer: BootstrapWriter,
  input: Omit<RecordingMetadata, 'recording'>,
  limitsInput: ReplayLimits,
): Promise<RecordingInfo> {
  let source = preparation.kind === 'open' ? preparation.baseline : undefined;
  let createdId: string | undefined;
  let closeAttempted = false;
  try {
    const fields = objectFields(input, ['id', 'name', 'createdAt']);
    const metadata = decodeRecordingMetadata({
      ...fields,
      recording:
        preparation.kind === 'open'
          ? preparation.baseline.recording
          : preparation.plan.recording,
    });
    if (source) decodePosition(source.position);
    const binding =
      preparation.kind === 'planned'
        ? decodeCaptureBinding(preparation.plan.binding)
        : undefined;
    const limits = decodeReplayLimits(limitsInput);
    await writer.create(metadata);
    createdId = metadata.id;
    if (preparation.kind === 'planned' && binding) {
      await preparation.bind(metadata.id, binding);
      source = await preparation.plan.openBaseline();
    }
    if (
      !source ||
      JSON.stringify(decodeRecordingSchema(source.recording)) !==
        JSON.stringify(metadata.recording)
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Opened baseline differs from the planned recording.',
      );
    const position = decodePosition(source.position);
    let count = 0;
    let bytes = 0;
    while (true) {
      const inputRows = await source.next();
      if (inputRows === null) break;
      let batchBytes = 2;
      const rows = boundedArray(inputRows, 100).map((inputRow, index) => {
        const entry = decodeSnapshotRow(metadata.recording, inputRow);
        batchBytes +=
          utf8Bytes(JSON.stringify(entry), 2 * 1024 * 1024) + (index ? 1 : 0);
        if (batchBytes > 16 * 1024 * 1024)
          throw new HistoryError(
            'LIMIT_EXCEEDED',
            'Baseline batch exceeds 16 MiB.',
          );
        const table = findTable(metadata.recording.schema, entry.tableId);
        count++;
        bytes += retainedBytes(
          rowKey(metadata.recording, table, entry.row),
          entry.row,
        );
        checkReplaySize(limits, count, bytes);
        return entry;
      });
      if (!rows.length)
        throw new HistoryError(
          'INVALID_HISTORY',
          'Baseline batches must be nonempty.',
        );
      await writer.stageBaseline(metadata.id, rows);
    }
    closeAttempted = true;
    await source.close();
    return await writer.publishBaseline(metadata.id, position);
  } catch (error) {
    const failures: unknown[] = [error];
    if (source && !closeAttempted) {
      try {
        await source.close();
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }
    if (createdId !== undefined) {
      try {
        await writer.setStatus(createdId, 'invalid');
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }
    if (failures.length > 1)
      throw new HistoryError(
        'STORAGE_FAILURE',
        'Baseline capture failed and cleanup was incomplete.',
        {
          cause: new AggregateError(failures),
        },
      );
    throw error;
  }
}
