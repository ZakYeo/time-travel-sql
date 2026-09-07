import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { PostgresConnection } from '@time-travel-sql/source-postgres';

/** Private fixture transport for committed-response loss or a stalled lease probe. */
export async function postgresResponseProxy(
  connection: PostgresConnection,
  fault: 'commit-loss' | 'probe-stall',
) {
  const sockets = new Set<Socket>();
  let triggered = false;
  const server = createServer((socket) => {
    const upstream = createConnection(
      join(connection.host, '.s.PGSQL.' + connection.port),
    );
    for (const peer of [socket, upstream]) {
      sockets.add(peer);
      peer.on('close', () => sockets.delete(peer));
    }
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on('error', close);
    upstream.on('error', close);
    upstream.on('end', () => socket.end());
    socket.on('end', () => upstream.end());
    socket.pipe(upstream);
    let buffered = Buffer.alloc(0);
    let stalled = false;
    upstream.on('data', (chunk: Buffer) => {
      if (stalled) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 1024 * 1024) {
        close();
        return;
      }
      while (buffered.length >= 5) {
        const length = buffered.readUInt32BE(1) + 1;
        if (length < 5 || length > 1024 * 1024) {
          close();
          return;
        }
        if (buffered.length < length) return;
        const frame = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        if (
          fault === 'commit-loss' &&
          frame[0] === 67 &&
          frame.subarray(5).equals(Buffer.from('COMMIT\0'))
        ) {
          triggered = true;
          close();
          return;
        }
        // One text-format DataRow field containing SELECT 1's sole value.
        if (
          fault === 'probe-stall' &&
          frame[0] === 68 &&
          frame.length === 12 &&
          frame.readUInt16BE(5) === 1 &&
          frame.readInt32BE(7) === 1 &&
          frame[11] === 49
        ) {
          triggered = true;
          stalled = true;
          buffered = Buffer.alloc(0);
          return;
        }
        socket.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing proxy port');
  return {
    connection: { ...connection, host: '127.0.0.1', port: address.port },
    triggered: () => triggered,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
