import { fork } from 'node:child_process';
import type { PostgresConnection } from '@time-travel-sql/source-postgres';

export type CrashPoint = 'before-append' | 'after-append' | 'after-ack';
export interface CrashOptions {
  readonly connection: PostgresConnection;
  readonly path: string;
  readonly point: CrashPoint;
}

/** Owns only the recorder process created here; termination deliberately skips cleanup. */
export function recordingCrashProcess(options: CrashOptions) {
  const child = fork(new URL('./recording-crash-child.ts', import.meta.url), {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const ready = Promise.withResolvers<void>();
  const barrier = Promise.withResolvers<string>();
  const exited = Promise.withResolvers<NodeJS.Signals | null>();
  let errorOutput = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    errorOutput = (errorOutput + chunk.toString()).slice(-4096);
  });
  const fail = (error: Error): void => {
    ready.reject(error);
    barrier.reject(error);
  };
  child.on('error', fail);
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    if ('kind' in message && message.kind === 'ready') ready.resolve();
    if (
      'kind' in message &&
      message.kind === 'barrier' &&
      'position' in message &&
      typeof message.position === 'string'
    )
      barrier.resolve(message.position);
    if ('kind' in message && message.kind === 'error')
      fail(new Error('Recorder child failed before its crash barrier.'));
  });
  child.once('close', (_code, signal) => {
    clearTimeout(deadline);
    fail(new Error(`Recorder child exited before its barrier: ${errorOutput}`));
    exited.resolve(signal);
  });
  const deadline = setTimeout(() => {
    fail(
      new Error('Recorder child did not reach its barrier within 20 seconds.'),
    );
    child.kill('SIGKILL');
  }, 20000);
  // The owner may still be awaiting readiness when the other promise rejects.
  void ready.promise.catch(() => {
    /* Observed by the test. */
  });
  void barrier.promise.catch(() => {
    /* Observed by the test. */
  });
  child.send(options, (error) => {
    if (error) fail(error);
  });
  return {
    ready: ready.promise,
    barrier: barrier.promise,
    async kill() {
      child.kill('SIGKILL');
      return exited.promise;
    },
  };
}
