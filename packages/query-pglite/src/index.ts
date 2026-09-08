import { HistoryError } from '@time-travel-sql/sdk';
import type { HistoricalQueryEngine } from '@time-travel-sql/sdk';
import { runQuery } from './run-query.js';
import { cancelled } from './cancellation.js';

/** Each query owns a new in-memory engine. Capacity is deliberately one: WASM
 * memory is substantial and this API does not hide an unbounded waiting queue.
 */
export function createHistoricalQueryEngine(): HistoricalQueryEngine {
  const active = new Map<AbortController, Promise<unknown>>();
  const cleanupFailures: unknown[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    query(view, request, signal) {
      if (closed) return Promise.reject(cancelled());
      if (cleanupFailures.length)
        return Promise.reject(
          new HistoryError(
            'QUERY_FAILURE',
            'Historical query engine cannot be reused after a cleanup failure.',
          ),
        );
      if (active.size)
        return Promise.reject(
          new HistoryError(
            'LIMIT_EXCEEDED',
            'A historical query is already running.',
          ),
        );
      const controller = new AbortController();
      const task = runQuery(
        view,
        request,
        { controller, cleanupFailures },
        signal,
      );
      active.set(controller, task);
      const release = () => {
        active.delete(controller);
      };
      void task.then(release, release);
      return task;
    },
    close() {
      closed = true;
      closing ??= (async () => {
        for (const controller of active.keys()) controller.abort(cancelled());
        await Promise.allSettled([...active.values()]);
        if (cleanupFailures.length)
          throw new AggregateError(
            cleanupFailures,
            'Historical query resources did not close cleanly.',
          );
      })();
      return closing;
    },
  };
}
