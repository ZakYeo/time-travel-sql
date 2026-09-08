import { API_PATH, API_VERSION } from '@time-travel-sql/contracts';
import { startLocalApi } from './server.js';
import { owned } from '../owned.js';

export async function serve(
  workspace: string,
  port: string | undefined,
  json: boolean,
  signal: AbortSignal,
  stdout: (text: string, signal: AbortSignal) => Promise<void>,
): Promise<number> {
  return owned(
    await startLocalApi({
      workspace,
      ...(port === undefined ? {} : { port: Number(port) }),
    }),
    async (server) => {
      const data = {
        origin: server.origin,
        endpoint: API_PATH,
        token: server.token,
      };
      await stdout(
        json
          ? JSON.stringify({ version: API_VERSION, ok: true, data }) + '\n'
          : `Local API: ${server.origin}${API_PATH}\nSession token: ${server.token}\nStop with Ctrl+C.\n`,
        signal,
      );
      const stopped = Promise.withResolvers<void>();
      const stop = () => stopped.resolve();
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      try {
        await Promise.race([server.closed, stopped.promise]);
      } finally {
        signal.removeEventListener('abort', stop);
      }
      return 0;
    },
  );
}
