import { HistoryError } from '../domain/errors.js';
import type { RowHistoryOptions } from '../domain/row-history.js';
import type { InvestigationControl } from './investigation-work.js';
import type { HistoryReplayWork } from './replay-history.js';

export class RowHistoryWork implements HistoryReplayWork {
  replayedTransactions = 0;
  events = 0;
  inputBytes = 0;
  constructor(
    readonly limits: RowHistoryOptions,
    readonly control: InvestigationControl,
  ) {
    this.check();
  }
  check(): void {
    if (this.control.signal.aborted)
      throw new HistoryError('CANCELLED', 'Row history cancelled.');
  }
  addBytes(bytes: number): void {
    if (bytes > this.limits.maxInputBytes - this.inputBytes)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Row history exceeds its aggregate input budget.',
      );
    this.inputBytes += bytes;
  }
  async cooperate(): Promise<void> {
    this.check();
    await this.control.cooperate();
    this.check();
  }
}
