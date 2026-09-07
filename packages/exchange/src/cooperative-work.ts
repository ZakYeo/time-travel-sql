import { setImmediate } from 'node:timers/promises';
import { checkCancelled } from './limits.js';

/** Async iterators alone can monopolize microtasks on already-buffered input. */
export class CooperativeWork {
  #bytes = 0;
  #records = 0;

  constructor(readonly signal: AbortSignal) {}

  async advance(bytes: number): Promise<void> {
    checkCancelled(this.signal);
    this.#bytes += bytes;
    this.#records++;
    if (this.#bytes >= 65536 || this.#records >= 256) {
      this.#bytes = 0;
      this.#records = 0;
      await setImmediate();
      checkCancelled(this.signal);
    }
  }
}
