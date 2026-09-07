import { HistoryError } from '@time-travel-sql/sdk';

/** One operation budget, shared across every attempted checkpoint and fallback. */
export class ReplayWork {
  #bytes = 0;
  #rows = 0;
  #transactions = 0;
  #events = 0;
  #candidates = 0;

  constructor(readonly maxBytes = 512 * 1024 * 1024) {}

  charge(bytes: number): void {
    this.#bytes += bytes;
    if (this.#bytes > this.maxBytes) this.exceeded();
  }

  row(): void {
    if (++this.#rows > 1000000) this.exceeded();
  }
  transaction(events: number): void {
    this.#events += events;
    if (++this.#transactions > 100000 || this.#events > 1000000)
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
