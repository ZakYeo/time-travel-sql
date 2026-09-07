import { createHash } from 'node:crypto';
import { HistoryError } from '@time-travel-sql/sdk';
import type {
  RecordingInfo,
  SnapshotRow,
  CommittedTransaction,
  Position,
} from '@time-travel-sql/sdk';
import type { Reader } from './reader.js';
import { ReplayWork } from './replay-work.js';

/** Verifies ordered authoritative records and fingerprints the consumed prefix. */
export class HistoryScan {
  readonly #hash = createHash('sha256');
  #position: Position;
  #count = 0;

  constructor(
    readonly reader: Reader,
    readonly info: RecordingInfo,
    readonly work: ReplayWork = new ReplayWork(),
  ) {
    if (info.baselinePosition === null)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Baseline has not been published.',
      );
    if (
      reader.db
        .prepare(
          'SELECT count(*) AS count FROM transactions WHERE recording_id=?',
        )
        .get(info.id)?.count !== info.transactionCount
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Durable transaction count does not match recorded history.',
      );
    this.#position = info.baselinePosition;
    this.add([info.recording, info.baselinePosition]);
  }

  get count(): number {
    return this.#count;
  }
  get checksum(): string {
    return this.#hash.copy().digest('hex');
  }

  private add(value: unknown): void {
    this.#hash.update(JSON.stringify(value) + '\n');
  }

  *baseline(): Iterable<SnapshotRow> {
    for (const row of this.reader.allBaseline(this.info, this.work)) {
      this.work.row();
      this.add(row);
      yield row;
    }
  }

  *commitsThrough(position: Position): Iterable<CommittedTransaction> {
    for (const transaction of this.reader.allTransactions(
      this.info,
      this.#position,
      position,
      this.work,
    )) {
      if (transaction.previousPosition !== this.#position)
        throw new HistoryError(
          'INVALID_HISTORY',
          'Recorded history has a missing predecessor.',
        );
      this.#count++;
      this.work.transaction(transaction.events.length);
      this.add(transaction);
      this.#position = transaction.position;
      yield transaction;
    }
    if (this.#position !== position)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Selected position is not a recorded committed boundary.',
      );
    if (
      position === this.info.headPosition &&
      this.#count !== this.info.transactionCount
    )
      throw new HistoryError(
        'INVALID_HISTORY',
        'Durable progress does not match recorded history.',
      );
  }

  verifyPrefix(position: Position): void {
    // Consume and validate every authoritative record without materializing its state.
    for (const row of this.baseline()) void row;
    for (const transaction of this.commitsThrough(position)) void transaction;
  }
}
