import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { API_LIMITS } from '@time-travel-sql/contracts';
import { HistoryError, decodeDataFields } from '@time-travel-sql/sdk';
import { openLocalStore } from '@time-travel-sql/storage-local';
import { authorize, HttpError } from './security.js';
import { failure, readRequest, respond } from './messages.js';
import { operation } from './operations.js';

export interface LocalApiOptions {
  readonly workspace: string;
  readonly port?: number;
}
export interface LocalApi {
  readonly origin: string;
  /** Explicit local capability. Never place in URLs sent to HTTP or logs. */
  readonly token: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** Explicit composition entry point; importing it opens no files or sockets. */
export async function startLocalApi(input: LocalApiOptions): Promise<LocalApi> {
  const options = decodeDataFields(input, ['workspace', 'port']);
  if (
    typeof options.workspace !== 'string' ||
    !options.workspace.trim() ||
    options.workspace.includes('\0') ||
    !options.workspace.isWellFormed() ||
    options.workspace.length > 65536
  )
    throw new HistoryError('INVALID_VALUE', 'Expected a workspace directory.');
  const port = options.port ?? 0;
  if (
    typeof port !== 'number' ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new HistoryError('INVALID_VALUE', 'Expected a valid local port.');
  const workspace = resolve(options.workspace);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const path = join(workspace, 'history.sqlite');
  const token = randomBytes(32).toString('hex');
  let origin = '';
  const stopping = new AbortController();
  const pending = new Set<Promise<void>>();
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 10000,
      requestTimeout: API_LIMITS.timeoutMs,
      connectionsCheckingInterval: 1000,
      keepAliveTimeout: 1000,
    },
    (request, response) => {
      const work = async () => {
        const controller = new AbortController();
        const signal = AbortSignal.any([stopping.signal, controller.signal]);
        const timer = setTimeout(
          () =>
            controller.abort(
              new HttpError(408, 'TIMEOUT', 'API request deadline exceeded.'),
            ),
          API_LIMITS.timeoutMs,
        );
        const disconnected = () =>
          controller.abort(
            new HttpError(499, 'CANCELLED', 'Client disconnected.'),
          );
        const interruptBody = () => {
          if (!request.complete) request.destroy();
        };
        response.once('close', disconnected);
        signal.addEventListener('abort', interruptBody, { once: true });
        try {
          authorize(request, origin, token);
          if (stopping.signal.aborted)
            throw new HttpError(
              503,
              'STOPPING',
              'Local application is stopping.',
            );
          if (pending.size >= API_LIMITS.activeRequests)
            throw new HttpError(
              429,
              'BUSY',
              'Too many active operations; retry when one finishes.',
            );
          const input = await readRequest(request, signal);
          const result = await operation(input, store, path, signal);
          signal.throwIfAborted();
          respond(response, 200, result);
        } catch (error) {
          failure(response, signal.aborted ? signal.reason : error);
        } finally {
          // Keep the concurrency slot until a slow reader releases its response.
          if (!response.destroyed && !response.writableFinished)
            await new Promise<void>((done) => {
              response.once('finish', done);
              response.once('close', done);
              const terminate = () => {
                response.destroy();
                done();
              };
              signal.addEventListener('abort', terminate, { once: true });
              if (signal.aborted) terminate();
            });
          clearTimeout(timer);
          response.off('close', disconnected);
          signal.removeEventListener('abort', interruptBody);
        }
      };
      const task = work();
      pending.add(task);
      void task
        .finally(() => pending.delete(task))
        .catch(() => response.destroy());
    },
  );
  server.maxConnections = API_LIMITS.connections;
  server.maxHeadersCount = 0;
  const store = await openLocalStore({ path });
  let closing: Promise<void> | undefined;
  const lifecycle = Promise.withResolvers<void>();
  // Callers may observe closed later, without a transient unhandled rejection.
  void lifecycle.promise.catch(() => undefined);
  const close = (primary?: unknown): Promise<void> => {
    closing ??= (async () => {
      const errors: unknown[] = primary === undefined ? [] : [primary];
      stopping.abort(
        new HttpError(503, 'STOPPING', 'Local application is stopping.'),
      );
      if (server.listening) {
        const closed = new Promise<void>((done) => server.close(() => done()));
        server.closeAllConnections();
        await closed;
      } else server.closeAllConnections();
      await Promise.allSettled(pending);
      try {
        await store.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(errors, 'Local API and cleanup failed.');
    })();
    void closing.then(lifecycle.resolve, lifecycle.reject);
    return closing;
  };
  // Runtime socket/listener errors end the owned server and are observable.
  const runtimeError = (error: Error) => {
    void close(error).catch(() => undefined);
  };
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', runtimeError);
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('Expected local TCP address.'));
          return;
        }
        origin = `http://127.0.0.1:${address.port}`;
        done();
      });
    });
  } catch (error) {
    await close(error);
    throw error;
  }
  return { origin, token, closed: lifecycle.promise, close: () => close() };
}
