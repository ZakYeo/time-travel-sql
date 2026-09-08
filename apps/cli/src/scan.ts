import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import {
  HistoryError,
  decodeSavedCheck,
  scanInvariant,
} from '@time-travel-sql/sdk';
import type { Selection, SavedCheck } from '@time-travel-sql/sdk';
import { createLocalExporter } from '@time-travel-sql/storage-local';
import { createHistoricalQueryEngine } from '@time-travel-sql/query-pglite';
import { selection } from './selection.js';
import { owned } from './owned.js';

type ScanReport = Awaited<ReturnType<typeof scanInvariant>>;
interface PreparingReport {
  readonly phase: 'preparing';
  readonly recordingId: string;
  readonly checkId: string;
  readonly requestedRange: { readonly from: Selection; readonly to: Selection };
  readonly progress: {
    readonly evaluatedStates: 0;
    readonly lastEvaluatedPosition: null;
  };
  readonly outcome: {
    readonly kind: 'incomplete';
    readonly reason: 'cancelled';
  };
}
export class IncompleteScanError extends HistoryError {
  constructor(readonly report: ScanReport | PreparingReport) {
    super(
      report.outcome.kind === 'incomplete' && report.outcome.reason === 'limit'
        ? 'LIMIT_EXCEEDED'
        : 'CANCELLED',
      'Invariant scan did not complete; see reported range and progress.',
    );
  }
  reportFor(code: string) {
    return {
      ...this.report,
      outcome: {
        kind: 'incomplete',
        reason:
          code === 'TIMEOUT'
            ? 'timeout'
            : this.report.outcome.kind === 'incomplete'
              ? this.report.outcome.reason
              : 'cancelled',
      },
    };
  }
}
export async function scanCheck(
  path: string,
  operands: readonly string[],
  options: { limit?: string; 'max-states'?: string },
  timeoutMs: number,
  signal: AbortSignal,
) {
  const [id = '', checkId = '', from = '', to = ''] = operands;
  const range = { from: selection(from), to: selection(to) };
  let completed: (ScanReport & { readonly check: SavedCheck }) | undefined;
  try {
    const report = await owned(
      createLocalExporter({ path }),
      async (provider) =>
        owned(await provider.open(id, signal), async (history) => {
          const check = decodeSavedCheck(await history.savedCheck(checkId));
          return owned(createHistoricalQueryEngine(), async (engine) => {
            completed = {
              check,
              ...(await scanInvariant(
                history,
                engine,
                {
                  ...range,
                  query: {
                    ...check.query,
                    limits: {
                      ...check.query.limits,
                      ...(options.limit === undefined
                        ? {}
                        : { maxRows: Number(options.limit) }),
                    },
                  },
                  limits: {
                    timeoutMs,
                    ...(options['max-states'] === undefined
                      ? {}
                      : { maxStates: Number(options['max-states']) }),
                  },
                },
                {
                  signal,
                  now: () => performance.now(),
                  cooperate: async () => {
                    await setImmediate();
                  },
                },
              )),
            };
            return completed;
          });
        }),
    );
    if (signal.aborted)
      throw new HistoryError(
        'CANCELLED',
        'Invariant scan cancelled during cleanup.',
      );
    if (report.outcome.kind === 'incomplete')
      throw new IncompleteScanError(report);
    return report;
  } catch (error) {
    if (error instanceof IncompleteScanError) throw error;
    if (error instanceof HistoryError && error.code === 'CANCELLED') {
      throw new IncompleteScanError(
        completed
          ? {
              ...completed,
              outcome: { kind: 'incomplete', reason: 'cancelled' },
            }
          : {
              phase: 'preparing',
              recordingId: id,
              checkId,
              requestedRange: range,
              progress: { evaluatedStates: 0, lastEvaluatedPosition: null },
              outcome: { kind: 'incomplete', reason: 'cancelled' },
            },
      );
    }
    throw error;
  }
}
