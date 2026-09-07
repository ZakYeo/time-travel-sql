import { HistoryError } from '@time-travel-sql/sdk';

/** A configuration budget includes elapsed configuration I/O, never resets it. */
export function deadline(external: AbortSignal, initialMs: number) {
  const started = performance.now();
  const controller = new AbortController();
  const reason = new HistoryError('CANCELLED', 'Command deadline exceeded.');
  const signal = AbortSignal.any([external, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function setBudget(totalMs: number) {
    clearTimeout(timer);
    const remaining = totalMs - (performance.now() - started);
    if (remaining <= 0) controller.abort(reason);
    else timer = setTimeout(() => controller.abort(reason), remaining);
  }
  setBudget(initialMs);
  return {
    signal,
    setBudget,
    timedOut: () => signal.reason === reason,
    close: () => clearTimeout(timer),
  };
}
