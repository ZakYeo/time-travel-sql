import {
  decodeQueryRequest,
  MAX_QUERY_LIMITS,
  DEFAULT_QUERY_LIMITS,
} from '@time-travel-sql/sdk';
import { createLocalReconstructor } from '@time-travel-sql/storage-local';
import { createHistoricalQueryEngine } from '@time-travel-sql/query-pglite';
import { selection } from './selection.js';
import { owned } from './owned.js';

export async function queryHistory(
  path: string,
  operands: readonly string[],
  options: { limit?: string },
  timeoutMs: number,
  signal: AbortSignal,
) {
  const [recordingId = '', selected = '', sql = ''] = operands;
  const state = { recordingId, selection: selection(selected) };
  const request = decodeQueryRequest({
    sql,
    limits: {
      maxRows:
        options.limit === undefined
          ? DEFAULT_QUERY_LIMITS.maxRows
          : Number(options.limit),
      timeoutMs: Math.min(timeoutMs, MAX_QUERY_LIMITS.timeoutMs),
    },
  });
  return owned(createLocalReconstructor({ path }), async (provider) =>
    owned(await provider.open(state, signal), (view) =>
      owned(createHistoricalQueryEngine(), async (engine) => ({
        info: view.info,
        ...(await engine.query(view, request, signal)),
      })),
    ),
  );
}
