import { setImmediate } from 'node:timers/promises';
import {
  HistoryError,
  decodeDataFields,
  decodeDataArray,
  decodeQueryRequest,
  decodeReconstructionInfo,
  reconstructionRows,
  QueryResultBuffer,
} from '@time-travel-sql/sdk';
import type {
  QueryRequest,
  QueryResult,
  ReconstructionView,
  CancellationSignal,
} from '@time-travel-sql/sdk';
import { Connection } from './connection.js';
import { cancellable, cancelled, check } from './cancellation.js';

export interface QueryControl {
  readonly controller: AbortController;
  readonly cleanupFailures: unknown[];
}

export async function runQuery(
  view: ReconstructionView,
  input: QueryRequest,
  control: QueryControl,
  external?: CancellationSignal,
): Promise<QueryResult> {
  const { controller, cleanupFailures } = control;
  const started = performance.now();
  const request = decodeQueryRequest(input);
  const signal = controller.signal;
  let connection: Connection | undefined;
  let result: QueryResult | undefined;
  const errors: unknown[] = [];
  const abort = () => controller.abort(cancelled());
  const timer = setTimeout(
    () =>
      controller.abort(
        new HistoryError(
          'LIMIT_EXCEEDED',
          'Historical query exceeded its deadline.',
        ),
      ),
    Math.max(1, request.limits.timeoutMs - (performance.now() - started)),
  );
  try {
    external?.addEventListener('abort', abort, { once: true });
    if (external?.aborted) abort();
    check(signal);
    const info = decodeReconstructionInfo(view.info);
    if (
      info.rowCount > request.limits.maxInputRows ||
      info.retainedBytes > request.limits.maxInputBytes
    )
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Historical query input exceeds its limit.',
      );
    const client = new Connection(info.recording.recording.schema, request);
    connection = client;
    const ready = decodeDataFields(
      await cancellable(signal, () => client.ready),
      ['kind'],
    );
    if (ready.kind !== 'ready')
      throw new HistoryError(
        'QUERY_FAILURE',
        'Historical query worker did not initialize.',
      );
    const borrowed: ReconstructionView = {
      info,
      rows: (table, page) => cancellable(signal, () => view.rows(table, page)),
    };
    for await (const { tableId, row } of reconstructionRows(borrowed)) {
      check(signal);
      const ack = decodeDataFields(
        await cancellable(signal, () =>
          client.request({ kind: 'load', tableId, row }),
        ),
        ['kind'],
      );
      if (ack.kind !== 'loaded')
        throw new HistoryError(
          'QUERY_FAILURE',
          'Historical query row was not acknowledged.',
        );
    }
    const prepared = decodeDataFields(
      await cancellable(signal, () => client.request({ kind: 'prepare' })),
      ['kind'],
    );
    if (prepared.kind !== 'prepared')
      throw new HistoryError(
        'QUERY_FAILURE',
        'Historical query policy was not prepared.',
      );
    const response = decodeDataFields(
      await cancellable(signal, () => client.request({ kind: 'execute' })),
      ['kind', 'result'],
    );
    if (response.kind !== 'result')
      throw new HistoryError(
        'QUERY_FAILURE',
        'Historical query returned an invalid response.',
      );
    const output = decodeDataFields(response.result, ['columns', 'rows']);
    const buffer = new QueryResultBuffer(output.columns, request.limits);
    for (const row of decodeDataArray(output.rows, request.limits.maxRows)) {
      check(signal);
      buffer.append(row);
      await setImmediate();
    }
    result = buffer.finish();
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await connection?.close();
    } catch (error) {
      cleanupFailures.push(error);
      errors.push(error);
    }
    clearTimeout(timer);
    try {
      external?.removeEventListener('abort', abort);
    } catch (error) {
      cleanupFailures.push(error);
      errors.push(error);
    }
  }
  if (errors.length > 1)
    throw new AggregateError(errors, 'Historical query and cleanup failed.');
  if (errors.length) throw errors[0];
  if (performance.now() - started >= request.limits.timeoutMs)
    controller.abort(
      new HistoryError(
        'LIMIT_EXCEEDED',
        'Historical query exceeded its deadline.',
      ),
    );
  check(signal);
  if (!result)
    throw new HistoryError(
      'QUERY_FAILURE',
      'Historical query returned no result.',
    );
  return result;
}
