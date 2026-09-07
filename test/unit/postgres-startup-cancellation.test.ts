import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { expect, it } from 'vitest';
import {
  inspectPostgresCapture,
  readSnapshot,
} from '@time-travel-sql/source-postgres';

it.each(['preflight', 'snapshot'] as const)(
  'cancels %s while the server stalls authentication and closes the owned socket',
  async (kind) => {
    const startup = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('data', () => startup.resolve());
      socket.on('close', () => {
        sockets.delete(socket);
        disconnected.resolve();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test socket');
    const controller = new AbortController();
    const connection = {
      host: '127.0.0.1',
      port: address.port,
      database: 'test',
      user: 'test',
    };
    const options = {
      connection,
      tables: [{ namespace: 'public', name: 'items' }],
      signal: controller.signal,
    };
    try {
      const pending =
        kind === 'preflight'
          ? inspectPostgresCapture({
              ...options,
              publication: 'tts_test',
              schemaId: 'schema',
            })
          : readSnapshot({ ...options, slot: 'tts_test' }).next();
      const rejected = expect(pending).rejects.toBeInstanceOf(Error);
      await startup.promise;
      controller.abort();
      await rejected;
      await disconnected.promise;
      expect(sockets.size).toBe(0);
    } finally {
      controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  5000,
);
