import { Worker } from 'node:worker_threads';
import { HistoryError } from '@time-travel-sql/sdk';
import type { LocalStoreOptions } from './database.js';
import type { Command, Request, Response, LocalStore } from './protocol.js';
import { encode, MAX_MESSAGE_BYTES } from './integrity.js';

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly bytes: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class Client {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  readonly ready: Promise<unknown>;
  readonly #exited: Promise<void>;
  #sequence = 0;
  #queuedBytes = 0;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(options: LocalStoreOptions) {
    this.#worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: options,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.ready = new Promise((resolve, reject) =>
      this.#pending.set(0, {
        resolve,
        reject,
        bytes: 0,
        timer: setTimeout(() => this.fail(), 30000),
      }),
    );
    this.#worker.on('message', (response: Response) => {
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      clearTimeout(pending.timer);
      this.#queuedBytes -= pending.bytes;
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new HistoryError(response.code, response.message));
    });
    this.#worker.on('error', () => this.fail());
    this.#exited = new Promise((resolve) =>
      this.#worker.once('exit', () => {
        this.fail();
        resolve();
      }),
    );
  }

  private fail(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new HistoryError(
          'STORAGE_FAILURE',
          'Local storage worker is unavailable.',
        ),
      );
    }
    this.#pending.clear();
    this.#queuedBytes = 0;
    void this.#worker.terminate();
  }

  request<C extends Command>(
    command: C,
  ): Promise<Awaited<ReturnType<LocalStore[C['method']]>>>;
  request(command: { readonly method: 'close' }): Promise<unknown>;
  async request(
    command: Command | { readonly method: 'close' },
  ): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(
        new HistoryError('STORAGE_FAILURE', 'Local storage is closed.'),
      );
    const request: Request = { id: ++this.#sequence, command };
    const bytes = Buffer.byteLength(encode(request).data);
    if (
      command.method !== 'close' &&
      (this.#queuedBytes + bytes > MAX_MESSAGE_BYTES * 2 ||
        this.#pending.size >= 128)
    )
      return Promise.reject(
        new HistoryError(
          'LIMIT_EXCEEDED',
          'Local storage request queue is full.',
        ),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), 30000);
      this.#pending.set(request.id, { resolve, reject, bytes, timer });
      this.#queuedBytes += bytes;
      try {
        this.#worker.postMessage(request);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(request.id);
        this.#queuedBytes -= bytes;
        reject(error);
      }
    });
  }

  close(): Promise<void> {
    this.#closing ??= this.finish();
    return this.#closing;
  }

  private async finish(): Promise<void> {
    if (!this.#closed) {
      const completed = this.request({ method: 'close' });
      this.#closed = true;
      try {
        await completed;
      } finally {
        await this.#worker.terminate();
      }
    }
    await this.#exited;
  }
}
