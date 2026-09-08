import { HistoryError } from '../domain/errors.js';
import { decodeScanLimits } from '../domain/invariant.js';
import type { ScanLimits } from '../domain/invariant.js';
import { decodeRecordingInfo } from '../domain/recordings.js';
import { decodeQueryRequest } from '../domain/query.js';
import type { QueryRequest, QueryResult } from '../domain/query.js';
import { QueryResultBuffer } from '../domain/query-result.js';
import type { CommittedTransaction } from '../domain/events.js';
import type { Position } from '../domain/position.js';
import type { Selection } from '../domain/selection.js';
import { boundedArray, objectFields } from '../domain/validation.js';
import type { RecordingExport } from '../ports/export.js';
import type { HistoricalQueryEngine } from '../ports/query.js';
import { resolveHistoryRange } from './resolve-history-range.js';
import { ScanTimeout, ScanWork } from './scan-work.js';
import type { ScanControl } from './scan-work.js';
import { replayHistory } from './replay-history.js';
import { scanView } from './scan-view.js';
import { compareReconstructedStates } from './compare-reconstructed-states.js';
import { decodeInvestigationOptions } from '../domain/investigation.js';

export interface InvariantScanRequest {
  readonly from: Selection;
  readonly to: Selection;
  readonly query: QueryRequest;
  readonly limits?: Partial<ScanLimits>;
}
export type ScanOutcome =
  | { readonly kind: 'clear' }
  | {
      readonly kind: 'incomplete';
      readonly reason: 'cancelled' | 'timeout' | 'limit';
    }
  | {
      readonly kind: 'violation';
      readonly position: Position;
      readonly predecessor: Position | null;
      readonly startingState: boolean;
      readonly transaction: CommittedTransaction | null;
      readonly rows: QueryResult;
      readonly diff: Awaited<
        ReturnType<typeof compareReconstructedStates>
      > | null;
    };

/** Evaluates every selected committed state chronologically, stopping at the first
 * observed violation. Caller owns history and engine and opens history with the
 * control signal. Per-query deadlines are reduced to the remaining scan budget.
 */
export async function scanInvariant(
  history: RecordingExport,
  engine: HistoricalQueryEngine,
  request: InvariantScanRequest,
  control: ScanControl,
) {
  const query = decodeQueryRequest(request.query);
  const limits = decodeScanLimits(request.limits);
  const diffLimits = decodeInvestigationOptions({ limit: 1000 });
  const work = new ScanWork(limits, control);
  const info = decodeRecordingInfo(history.info);
  const pinned: RecordingExport = {
    info,
    baseline: (page) => history.baseline(page),
    transactions: (page) => history.transactions(page),
    transaction: (position) => history.transaction(position),
    close: () => history.close(),
  };
  const range = await resolveHistoryRange(
    pinned,
    request.from,
    request.to,
    control.signal,
  );
  const result = (outcome: ScanOutcome) =>
    Object.freeze({
      recording: info,
      range,
      limits,
      queryLimits: query.limits,
      diffLimits,
      progress: work.snapshot(),
      outcome: Object.freeze(outcome),
    });
  try {
    for await (const { state, previous, transaction } of replayHistory(
      pinned,
      range,
      work,
    )) {
      work.check();
      if (work.evaluatedStates === 0 && state.position !== range.from)
        throw new HistoryError(
          'INVALID_HISTORY',
          'Scan history skipped the selected starting state.',
        );
      if (work.evaluatedStates >= limits.maxStates)
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'Invariant scan exceeds its state budget.',
        );
      work.addBytes(state.retainedBytes);
      const queryLimits = {
        ...query.limits,
        timeoutMs: Math.max(
          1,
          Math.min(query.limits.timeoutMs, Math.floor(work.remaining())),
        ),
      };
      const raw = objectFields(
        await engine.query(
          scanView(info, state),
          { ...query, limits: queryLimits },
          control.signal,
        ),
        ['columns', 'rows'],
      );
      work.check();
      const buffer = new QueryResultBuffer(raw.columns, queryLimits);
      for (const row of boundedArray(raw.rows, queryLimits.maxRows))
        buffer.append(row);
      const rows = buffer.finish();
      work.check();
      work.evaluatedStates++;
      work.lastEvaluatedPosition = state.position;
      control.progress?.(work.snapshot());
      work.check();
      if (rows.rows.length) {
        let diff: Awaited<
          ReturnType<typeof compareReconstructedStates>
        > | null = null;
        if (previous) {
          work.addBytes(previous.retainedBytes + state.retainedBytes);
          diff = await compareReconstructedStates(
            {
              from: scanView(info, previous),
              to: scanView(info, state),
              close: async () => {},
            },
            diffLimits,
            { signal: control.signal, cooperate: () => work.cooperate() },
          );
          work.check();
        }
        return result({
          kind: 'violation',
          position: state.position,
          predecessor: transaction?.previousPosition ?? null,
          startingState: state.position === range.from,
          transaction,
          rows,
          diff,
        });
      }
    }
    work.check();
    return result({ kind: 'clear' });
  } catch (error) {
    if (!(error instanceof HistoryError)) throw error;
    if (error.code === 'CANCELLED')
      return result({ kind: 'incomplete', reason: 'cancelled' });
    if (error.code === 'LIMIT_EXCEEDED')
      return result({
        kind: 'incomplete',
        reason:
          error instanceof ScanTimeout || work.remaining() <= 0
            ? 'timeout'
            : 'limit',
      });
    throw error;
  }
}
