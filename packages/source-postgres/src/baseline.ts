import {
  HistoryError,
  decodeRecordingSchema,
  decodeStableId,
} from '@time-travel-sql/sdk';
import type { SourceBaseline, SnapshotRow } from '@time-travel-sql/sdk';
import { readSnapshot } from './snapshot.js';
import type { SnapshotOptions } from './snapshot.js';
import { postgresSchema, postgresTableId, postgresRow } from './schema.js';

function baselineFailure(error: unknown, cancelled: boolean): HistoryError {
  if (cancelled)
    return new HistoryError('CANCELLED', 'PostgreSQL baseline was cancelled.', {
      cause: error,
    });
  return error instanceof HistoryError
    ? error
    : new HistoryError(
        'STORAGE_FAILURE',
        'PostgreSQL baseline capture failed.',
        { cause: error },
      );
}

export interface PostgresBaselineOptions extends SnapshotOptions {
  readonly sourceId: string;
  readonly epochId: string;
  readonly schemaId: string;
}

export interface PostgresBaseline extends SourceBaseline {
  readonly systemId: string;
  readonly timeline: string;
  readonly databaseOid: string;
}

/** Creates a new persistent slot; failure retains it for explicit owned cleanup. */
export async function openPostgresBaseline(
  options: PostgresBaselineOptions,
): Promise<PostgresBaseline> {
  const sourceId = decodeStableId(options.sourceId);
  const epochId = decodeStableId(options.epochId);
  const schemaId = decodeStableId(options.schemaId);
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  // Fifteen maximum-sized canonical rows leave room for table IDs and framing.
  // Preserve invalid options for the primitive's canonical configuration checks.
  const batchSize =
    options.batchSize === undefined || options.batchSize === 16
      ? 15
      : options.batchSize;
  const iterator = readSnapshot({ ...options, batchSize, signal });
  let closing: Promise<void> | undefined;
  let reading = true;
  const close = (): Promise<void> => {
    if (reading) controller.abort();
    closing ??= iterator.return(undefined).then(
      () => undefined,
      (error: unknown) => {
        // The primitive reports an idle abort during its final settlement. It is
        // an intentional cancellation only when no connection/cleanup error exists.
        if (
          signal.aborted &&
          error instanceof AggregateError &&
          error.errors.length === 1 &&
          error.errors[0] === signal.reason
        )
          return;
        throw baselineFailure(error, false);
      },
    );
    return closing;
  };
  try {
    const first = await iterator.next();
    reading = false;
    signal.throwIfAborted();
    if (first.done || first.value.kind !== 'begin')
      throw new HistoryError(
        'INVALID_HISTORY',
        'Snapshot did not provide a boundary.',
      );
    const begin = first.value;
    const recording = decodeRecordingSchema({
      sourceId,
      epochId,
      schema: postgresSchema(schemaId, begin.tables),
    });
    const tables = new Map(
      recording.schema.tables.map((table) => [table.id, table]),
    );
    let complete = false;
    return Object.freeze({
      recording,
      position: begin.position,
      systemId: begin.systemId,
      timeline: begin.timeline,
      databaseOid: begin.databaseOid,
      async next(): Promise<readonly SnapshotRow[] | null> {
        if (closing || signal.aborted)
          throw new HistoryError(
            'CANCELLED',
            'PostgreSQL baseline was cancelled.',
          );
        if (reading)
          throw new HistoryError(
            'INVALID_HISTORY',
            'A baseline read is already pending.',
          );
        if (complete) return null;
        reading = true;
        try {
          const part = await iterator.next();
          signal.throwIfAborted();
          if (part.done || part.value.kind === 'begin')
            throw new HistoryError(
              'INVALID_HISTORY',
              'Snapshot ended without completion.',
            );
          if (part.value.kind === 'complete') {
            if (!(await iterator.next()).done)
              throw new HistoryError(
                'INVALID_HISTORY',
                'Snapshot continued after completion.',
              );
            signal.throwIfAborted();
            complete = true;
            return null;
          }
          const table = tables.get(postgresTableId(part.value.tableOid));
          if (!table)
            throw new HistoryError(
              'INVALID_SCHEMA',
              'Snapshot references an unknown table.',
            );
          return Object.freeze(
            part.value.rows.map((raw) =>
              Object.freeze({
                tableId: table.id,
                row: postgresRow(table, raw),
              }),
            ),
          );
        } catch (error) {
          const failure = baselineFailure(error, signal.aborted);
          try {
            await close();
          } catch (cleanup) {
            throw new HistoryError(
              'STORAGE_FAILURE',
              'Snapshot capture and cleanup failed.',
              {
                cause: new AggregateError([failure, cleanup]),
              },
            );
          }
          throw failure;
        } finally {
          reading = false;
        }
      },
      close,
    });
  } catch (error) {
    const failure = baselineFailure(error, signal.aborted);
    try {
      await close();
    } catch (cleanup) {
      throw new HistoryError(
        'STORAGE_FAILURE',
        'Snapshot startup and cleanup failed.',
        {
          cause: new AggregateError([failure, cleanup]),
        },
      );
    }
    throw failure;
  }
}
