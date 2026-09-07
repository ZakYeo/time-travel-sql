import { HistoryError, HistoryState } from '@time-travel-sql/sdk';
import type { RecordingInfo } from '@time-travel-sql/sdk';
import type { SQLOutputValue } from 'node:sqlite';
import type { Reader } from './reader.js';

/** One head only. External commits invalidate it through SQLite data_version. */
export class ReplayCache {
  #cached:
    | { info: string; version: SQLOutputValue | undefined; state: HistoryState }
    | undefined;

  constructor(readonly reader: Reader) {}

  clear(): void {
    this.#cached = undefined;
  }

  remember(info: RecordingInfo, state: HistoryState): void {
    this.#cached = {
      info: JSON.stringify(info),
      version: this.version(),
      state,
    };
  }

  private version(): SQLOutputValue | undefined {
    return this.reader.db.prepare('PRAGMA data_version').get()?.data_version;
  }

  load(info: RecordingInfo): HistoryState {
    if (
      this.#cached?.info === JSON.stringify(info) &&
      this.#cached.version === this.version()
    )
      return this.#cached.state;
    let state = HistoryState.fromSnapshot(
      info.recording,
      info.baselinePosition,
      this.reader.allBaseline(info),
    );
    let count = 0;
    for (const committed of this.reader.allTransactions(info)) {
      state = state.apply(committed);
      count++;
    }
    if (state.position !== info.headPosition || count !== info.transactionCount)
      throw new HistoryError(
        'INVALID_HISTORY',
        'Durable progress does not match recorded history.',
      );
    this.remember(info, state);
    return state;
  }
}
