import { HistoryError } from '@time-travel-sql/sdk';
import type { CommittedTransaction, Position } from '@time-travel-sql/sdk';

/** Exactly one transaction and one consumer wait; no unbounded application queue. */
export class StreamDelivery {
  #pending:
    | {
        transaction: CommittedTransaction;
        delivered: boolean;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  #reader:
    | ReturnType<typeof Promise.withResolvers<CommittedTransaction>>
    | undefined;
  #failure: HistoryError | undefined;

  next(): Promise<CommittedTransaction> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#reader || this.#pending?.delivered)
      return Promise.reject(
        new HistoryError(
          'INVALID_HISTORY',
          'Only one read is allowed before durable acknowledgement.',
        ),
      );
    if (this.#pending) {
      this.#pending.delivered = true;
      return Promise.resolve(this.#pending.transaction);
    }
    this.#reader = Promise.withResolvers<CommittedTransaction>();
    return this.#reader.promise;
  }

  publish(transaction: CommittedTransaction): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#pending)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'A transaction is already awaiting durable acknowledgement.',
      );
    this.#pending = {
      transaction,
      delivered: !!this.#reader,
      release: Promise.withResolvers<void>(),
    };
    this.#reader?.resolve(transaction);
    this.#reader = undefined;
    return this.#pending.release.promise;
  }

  require(position: Position): void {
    if (this.#failure) throw this.#failure;
    if (
      !this.#pending?.delivered ||
      this.#pending.transaction.position !== position
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Acknowledge the exact delivered transaction after durable append.',
      );
  }

  release(): void {
    this.#pending?.release.resolve();
    this.#pending = undefined;
  }

  fail(error: HistoryError): void {
    this.#failure ??= error;
    this.#reader?.reject(this.#failure);
    this.#reader = undefined;
    // Resume the driver callback so its flow-control loop can stop cleanly.
    this.release();
  }
}
