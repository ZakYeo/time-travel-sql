import type { HistoryState } from '@time-travel-sql/sdk';
import type { RecordingInfo } from '@time-travel-sql/sdk';
import type { SQLOutputValue } from 'node:sqlite';
import type { Reader } from './reader.js';
import type { Checkpoints } from './checkpoints.js';

/** One head only. External commits invalidate it through SQLite data_version. */
export class ReplayCache {
  #cached:
    | { info: string; version: SQLOutputValue | undefined; state: HistoryState }
    | undefined;

  constructor(
    readonly reader: Reader,
    readonly checkpoints: Checkpoints,
  ) {}

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
    if (info.headPosition === null)
      throw new Error('Replay cache requires published history.');
    const state = this.checkpoints.restore(info, info.headPosition);
    this.remember(info, state);
    return state;
  }
}
