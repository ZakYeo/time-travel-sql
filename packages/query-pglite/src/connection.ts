import { Worker } from 'node:worker_threads';
import {
  HistoryError,
  decodeDataArray,
  decodeDataFields,
} from '@time-travel-sql/sdk';
import type { Schema, QueryRequest, ErrorCode } from '@time-travel-sql/sdk';

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}
const codes: readonly ErrorCode[] = [
  'INVALID_VALUE',
  'INVALID_SCHEMA',
  'INVALID_HISTORY',
  'LIMIT_EXCEEDED',
  'QUERY_REJECTED',
  'QUERY_FAILURE',
];

/** Single in-flight command: each row is acknowledged before another is sent. */
export class Connection {
  readonly #worker: Worker;
  readonly ready: Promise<unknown>;
  #pending: Pending | undefined;
  #failure: unknown;
  #failed = false;
  #completed = false;
  #closing: Promise<void> | undefined;

  constructor(schema: Schema, request: QueryRequest) {
    this.#worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { schema, request },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    // Engine diagnostics can contain SQL/data. They are deliberately not logged.
    this.#worker.stdout.resume();
    this.#worker.stderr.resume();
    this.ready = this.#receive();
    this.#worker.on('message', (input: unknown) => {
      try {
        const value = decodeDataFields(input, ['kind', 'result', 'errors']);
        if (value.kind === 'error') {
          const errors = decodeDataArray(value.errors, 2).map((input) => {
            const error = decodeDataFields(input, ['code', 'message']);
            const code = codes.find((code) => code === error.code);
            if (
              !code ||
              typeof error.message !== 'string' ||
              error.message.length > 512
            )
              throw new Error('Invalid worker error');
            return new HistoryError(code, error.message);
          });
          if (!errors.length) throw new Error('Missing worker error');
          this.#fail(
            errors.length === 1
              ? errors[0]
              : new AggregateError(
                  errors,
                  'Historical query and cleanup failed.',
                ),
          );
          return;
        }
        const pending = this.#pending;
        if (!pending) throw new Error('Unexpected worker response');
        this.#pending = undefined;
        if (value.kind === 'result') this.#completed = true;
        pending.resolve(value);
      } catch {
        this.#fail();
      }
    });
    this.#worker.on('error', () => this.#fail());
    this.#worker.on('exit', () => {
      if (!this.#completed && !this.#closing) this.#fail();
    });
  }

  #fail(
    error: unknown = new HistoryError(
      'QUERY_FAILURE',
      'The disposable historical query worker failed.',
    ),
  ): void {
    if (!this.#failed) {
      this.#failure = error;
      this.#failed = true;
    }
    this.#pending?.reject(this.#failure);
    this.#pending = undefined;
  }

  #receive(): Promise<unknown> {
    if (this.#failed) return Promise.reject(this.#failure);
    if (this.#pending)
      return Promise.reject(
        new HistoryError(
          'QUERY_FAILURE',
          'Historical query command is already pending.',
        ),
      );
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
  }

  request(command: unknown): Promise<unknown> {
    const result = this.#receive();
    if (!this.#failed) {
      try {
        this.#worker.postMessage(command);
      } catch {
        this.#fail();
      }
    }
    return result;
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#fail(
        new HistoryError('CANCELLED', 'Historical query worker closed.'),
      );
      await this.#worker.terminate();
    })();
    return this.#closing;
  }
}
