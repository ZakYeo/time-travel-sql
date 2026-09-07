import { HistoryError, TRANSACTION_LIMITS } from '@time-travel-sql/sdk';
import type { RowEvent } from '@time-travel-sql/sdk';

export interface PostgresTransactionLimits {
  readonly maxMessages?: number;
  readonly maxWireBytes?: number;
  readonly maxEvents?: number;
  readonly maxEventBytes?: number;
}

const maximum = Object.freeze({
  maxMessages: 100000,
  maxWireBytes: 64 * 1048576,
  maxEvents: TRANSACTION_LIMITS.maxEvents,
  maxEventBytes: TRANSACTION_LIMITS.maxBytes,
});

export class TransactionBudget {
  readonly #limits: Required<PostgresTransactionLimits>;
  #messages = 0;
  #wireBytes = 0;
  #events = 0;
  #eventBytes = 2;
  constructor(limits: PostgresTransactionLimits) {
    this.#limits = { ...maximum, ...limits };
    for (const key of Object.keys(maximum) as (keyof typeof maximum)[]) {
      const value = this.#limits[key];
      if (
        !Number.isSafeInteger(value) ||
        value < (key === 'maxEventBytes' ? 2 : 1) ||
        value > maximum[key]
      )
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'Invalid PostgreSQL transaction budget.',
        );
    }
  }
  frame(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new HistoryError(
        'INVALID_EVENT',
        'Invalid replication frame size.',
      );
    this.#messages++;
    this.#wireBytes += bytes;
    if (
      this.#messages > this.#limits.maxMessages ||
      this.#wireBytes > this.#limits.maxWireBytes
    )
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'PostgreSQL transaction exceeds its wire work budget.',
      );
  }
  event(event: RowEvent): void {
    this.#eventBytes +=
      Buffer.byteLength(JSON.stringify(event), 'utf8') + (this.#events ? 1 : 0);
    this.#events++;
    if (
      this.#events > this.#limits.maxEvents ||
      this.#eventBytes > this.#limits.maxEventBytes
    )
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'PostgreSQL transaction exceeds its canonical event budget.',
      );
  }
}
