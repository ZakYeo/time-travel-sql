import { Worker } from 'node:worker_threads';
import { HistoryError } from '@time-travel-sql/sdk';
import type {
  Command,
  Request,
  Response,
  WorkerOperations,
  Startup,
} from './protocol.js';
import { encode, MAX_MESSAGE_BYTES } from './integrity.js';

interface Pending {
  readonly done: Promise<void>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly bytes: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

function pendingRequest(
  resolve: Pending['resolve'],
  reject: Pending['reject'],
  bytes: number,
  timer: Pending['timer'],
): Pending {
  let finish = (): void => undefined;
  const done = new Promise<void>((resolveDone) => {
    finish = resolveDone;
  });
  return {
    bytes,
    timer,
    done,
    resolve(value) {
      finish();
      resolve(value);
    },
    reject(error) {
      finish();
      reject(error);
    },
  };
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
  #failure: HistoryError | undefined;

  constructor(startup: Startup) {
    const entry =
      startup.kind === 'store'
        ? './worker.js'
        : startup.kind === 'export'
          ? './export-worker.js'
          : './reconstruction-worker.js';
    this.#worker = new Worker(new URL(entry, import.meta.url), {
      workerData: startup,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.ready = new Promise((resolve, reject) =>
      this.#pending.set(
        0,
        pendingRequest(
          resolve,
          reject,
          0,
          setTimeout(() => this.fail(), 30000),
        ),
      ),
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
        if (this.#pending.size > 0 || !this.#closed) this.fail();
        resolve();
      }),
    );
  }

  private fail(
    error = new HistoryError(
      'STORAGE_FAILURE',
      'Local storage worker is unavailable.',
    ),
  ): void {
    this.#closed = true;
    this.#failure ??= error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#queuedBytes = 0;
    void this.#worker.terminate();
  }

  request<C extends Command>(
    command: C,
  ): Promise<Awaited<ReturnType<WorkerOperations[C['method']]>>>;
  request(command: { readonly method: 'close' }): Promise<unknown>;
  async request(
    command: Command | { readonly method: 'close' },
  ): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(
        this.#failure ??
          new HistoryError('STORAGE_FAILURE', 'Local storage is closed.'),
      );
    const request: Request = { id: ++this.#sequence, command };
    const bytes = Buffer.byteLength(encode(request).data);
    while (
      command.method !== 'close' &&
      (this.#queuedBytes + bytes > MAX_MESSAGE_BYTES * 2 ||
        this.#pending.size >= 128)
    ) {
      if (
        command.method !== 'releaseRecording' &&
        command.method !== 'closeImport'
      )
        throw new HistoryError(
          'LIMIT_EXCEEDED',
          'Local storage request queue is full.',
        );
      // Cleanup waits for admission without exceeding the ordinary queue bound.
      await Promise.race(
        [...this.#pending.values()].map((pending) => pending.done),
      );
      if (this.#closed)
        throw (
          this.#failure ??
          new HistoryError('STORAGE_FAILURE', 'Local storage is closed.')
        );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), 30000);
      const pending = pendingRequest(resolve, reject, bytes, timer);
      this.#pending.set(request.id, pending);
      this.#queuedBytes += bytes;
      try {
        this.#worker.postMessage(request);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(request.id);
        this.#queuedBytes -= bytes;
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  close(): Promise<void> {
    this.#closing ??= this.finish();
    return this.#closing;
  }

  async cancel(): Promise<void> {
    this.fail(
      new HistoryError('CANCELLED', 'Local read operation was cancelled.'),
    );
    await this.#exited;
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
