import { HistoryError, HISTORY_WORK_LIMITS } from '@time-travel-sql/sdk';

/** One operation budget, shared across every attempted checkpoint and fallback. */
export class ReplayWork {
  #bytes = 0;
  #rows = 0;
  #transactions = 0;
  #events = 0;
  #candidates = 0;

  constructor(readonly maxBytes = HISTORY_WORK_LIMITS.maxBytes) {}

  charge(bytes: number): void {
    this.#bytes += bytes;
    if (this.#bytes > this.maxBytes) this.exceeded();
  }

  row(): void {
    if (++this.#rows > HISTORY_WORK_LIMITS.maxRows) this.exceeded();
  }
  transaction(events: number): void {
    this.#events += events;
    if (
      ++this.#transactions > HISTORY_WORK_LIMITS.maxTransactions ||
      this.#events > HISTORY_WORK_LIMITS.maxEvents
    )
      this.exceeded();
  }
  candidate(): void {
    if (++this.#candidates > 1000) this.exceeded();
  }

  private exceeded(): never {
    throw new HistoryError(
      'LIMIT_EXCEEDED',
      'History verification exceeds its operation budget.',
    );
  }
}
