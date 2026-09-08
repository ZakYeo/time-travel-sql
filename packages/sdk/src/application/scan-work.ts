import { HistoryError } from '../domain/errors.js';
import type { ScanLimits } from '../domain/invariant.js';
import type { Position } from '../domain/position.js';
import type { InvestigationControl } from './investigation-work.js';

export interface ScanProgress {
  readonly evaluatedStates: number;
  readonly replayedTransactions: number;
  readonly events: number;
  readonly inputBytes: number;
  readonly lastEvaluatedPosition: Position | null;
}
export interface ScanControl extends InvestigationControl {
  /** Injected monotonic milliseconds. The host also opens history with signal. */
  readonly now: () => number;
  readonly progress?: (progress: ScanProgress) => void;
}
export class ScanTimeout extends HistoryError {
  constructor() {
    super('LIMIT_EXCEEDED', 'Invariant scan deadline exceeded.');
  }
}
export class ScanWork {
  readonly #started: number;
  #lastTime: number;
  evaluatedStates = 0;
  replayedTransactions = 0;
  events = 0;
  inputBytes = 0;
  lastEvaluatedPosition: Position | null = null;
  constructor(
    readonly limits: ScanLimits,
    readonly control: ScanControl,
  ) {
    this.#started = control.now();
    if (!Number.isFinite(this.#started))
      throw new HistoryError(
        'INVALID_VALUE',
        'Scan clock must be finite and monotonic.',
      );
    this.#lastTime = this.#started;
    this.check();
  }
  remaining(): number {
    const now = this.control.now();
    if (!Number.isFinite(now) || now < this.#lastTime)
      throw new HistoryError(
        'INVALID_VALUE',
        'Scan clock must be finite and monotonic.',
      );
    this.#lastTime = now;
    return this.limits.timeoutMs - (now - this.#started);
  }
  check(): void {
    if (this.control.signal.aborted)
      throw new HistoryError('CANCELLED', 'Invariant scan cancelled.');
    if (this.remaining() <= 0) throw new ScanTimeout();
  }
  addBytes(bytes: number): void {
    if (bytes > this.limits.maxBytes - this.inputBytes)
      throw new HistoryError(
        'LIMIT_EXCEEDED',
        'Invariant scan exceeds its input byte budget.',
      );
    this.inputBytes += bytes;
  }
  snapshot(): ScanProgress {
    return Object.freeze({
      evaluatedStates: this.evaluatedStates,
      replayedTransactions: this.replayedTransactions,
      events: this.events,
      inputBytes: this.inputBytes,
      lastEvaluatedPosition: this.lastEvaluatedPosition,
    });
  }
  async cooperate(): Promise<void> {
    this.check();
    this.control.progress?.(this.snapshot());
    await this.control.cooperate();
    this.check();
  }
}
