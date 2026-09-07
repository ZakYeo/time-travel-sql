import { decodeRecordingSchema } from '@time-travel-sql/sdk';
import type { SourceCapturePlan } from '@time-travel-sql/sdk';
import type { PostgresConnection } from './connection.js';
import type { PostgresCaptureLease } from './capture-lease.js';
import { createPostgresCaptureBinding } from './capture-binding.js';
import { openPostgresBaseline } from './baseline.js';

export interface PostgresCapturePlanOptions {
  readonly connection: PostgresConnection;
  readonly lease: PostgresCaptureLease;
  readonly sourceId: string;
  readonly epochId: string;
  readonly signal: AbortSignal;
}

/** Does not create a slot. The caller retains ownership of the capture lease. */
export function planPostgresCapture(
  options: PostgresCapturePlanOptions,
): SourceCapturePlan {
  const { lease, signal } = options;
  lease.assertActive();
  signal.throwIfAborted();
  const recording = decodeRecordingSchema({
    sourceId: options.sourceId,
    epochId: options.epochId,
    schema: lease.receipt.schema,
  });
  const connection = { ...options.connection };
  return Object.freeze({
    recording,
    binding: createPostgresCaptureBinding(recording, lease.receipt),
    openBaseline: () =>
      openPostgresBaseline({
        connection,
        lease,
        signal,
        sourceId: recording.sourceId,
        epochId: recording.epochId,
        schemaId: recording.schema.id,
        slot: lease.receipt.slot,
        tables: recording.schema.tables.map((table) => ({
          namespace: table.namespace,
          name: table.name,
        })),
      }),
  });
}
