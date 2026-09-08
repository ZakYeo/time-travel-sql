import type { RecordingInfo } from '@time-travel-sql/sdk';
import type { PostgresRecordingSession } from '@time-travel-sql/source-postgres';

/** One outstanding bounded delivery; session completion cancels stalled progress. */
export async function captureProgress(
  session: PostgresRecordingSession,
  info: () => Promise<RecordingInfo>,
  emit: (data: unknown, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  durationMs?: number,
): Promise<RecordingInfo> {
  const stop = () => {
    void session.stop().catch(() => {
      /* The completion promise below retains the failure. */
    });
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const duration =
    durationMs === undefined ? undefined : setTimeout(stop, durationMs);
  const completed = new AbortController();
  const done = session.done
    .then(
      (value) => ({ kind: 'done', ok: true, value }) as const,
      (error: unknown) => ({ kind: 'done', ok: false, error }) as const,
    )
    .then((outcome) => {
      completed.abort();
      return outcome;
    });
  const result = async () => {
    const outcome = await done;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };
  try {
    while (true) {
      if (completed.signal.aborted) return await result();
      const current = await info();
      try {
        await emit(
          {
            ...session.status(),
            status: current.status,
            baselinePosition: current.baselinePosition,
            headPosition: current.headPosition,
            transactionCount: current.transactionCount,
          },
          AbortSignal.any([
            signal,
            completed.signal,
            AbortSignal.timeout(1000),
          ]),
        );
      } catch (error) {
        if (completed.signal.aborted) return await result();
        throw error;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<{ kind: 'tick' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'tick' }), 1000);
      });
      try {
        const next = await Promise.race([done, tick]);
        if (next.kind === 'done') return await result();
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    try {
      await session.stop();
    } catch (cleanup) {
      if (cleanup !== error)
        throw new AggregateError(
          [error, cleanup],
          'Capture and shutdown failed.',
          { cause: cleanup },
        );
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', stop);
    clearTimeout(duration);
  }
}
