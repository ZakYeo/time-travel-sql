import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { PostgresConnection } from '@time-travel-sql/source-postgres';

/** Test-owned transport: drop existing sockets or blackhole only initial startup. */
export async function postgresTransportProxy(
  connection: PostgresConnection,
  stallFirst = false,
) {
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    if (++accepted === 1 && stallFirst) {
      socket.resume();
      return;
    }
    const upstream = createConnection(
      join(connection.host, '.s.PGSQL.' + connection.port),
    );
    sockets.add(upstream);
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('close', () => {
      sockets.delete(upstream);
      close();
    });
    socket.on('close', close);
    upstream.on('error', close);
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing transport proxy port');
  const drop = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    connection: { ...connection, host: '127.0.0.1', port: address.port },
    drop,
    accepted: () => accepted,
    async close() {
      drop();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
