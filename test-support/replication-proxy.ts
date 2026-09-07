import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { PostgresConnection } from '@time-travel-sql/source-postgres';

/** Forward preflight connections; stall the third (actual stream) authentication. */
export async function stalledStreamProxy(connection: PostgresConnection) {
  const sockets = new Set<Socket>();
  const startup = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  let count = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (++count === 3) {
      socket.once('data', () => startup.resolve());
      socket.once('close', () => disconnected.resolve());
      return;
    }
    const upstream = createConnection(
      join(connection.host, '.s.PGSQL.' + connection.port),
    );
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing proxy port');
  return {
    connection: { ...connection, host: '127.0.0.1', port: address.port },
    startup: startup.promise,
    disconnected: disconnected.promise,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
