import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { PostgresConnection } from '@time-travel-sql/source-postgres';

/** Routes the first connection to the exporter cluster and later ones elsewhere. */
export async function postgresRoutingProxy(
  first: PostgresConnection,
  later: PostgresConnection,
) {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    const target = connections++ === 0 ? first : later;
    const upstream = createConnection(
      join(target.host, '.s.PGSQL.' + target.port),
    );
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    for (const peer of [socket, upstream]) {
      sockets.add(peer);
      peer.on('close', () => {
        sockets.delete(peer);
        close();
      });
      peer.on('error', close);
    }
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing proxy port');
  return {
    connection: { ...first, host: '127.0.0.1', port: address.port },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
