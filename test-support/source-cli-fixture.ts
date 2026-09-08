import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { PostgresConnection } from '@time-travel-sql/source-postgres';

export function sourceConfig(
  connection: PostgresConnection = {
    host: 'invalid.example',
    port: 5432,
    user: 'operator',
    database: 'source',
  },
) {
  return {
    connection: {
      host: connection.host,
      port: connection.port,
      user: connection.user,
      database: connection.database,
      passwordEnv: 'TTS_TEST_SOURCE_PASSWORD',
      sslMode: 'disable',
    },
    schemaId: 'schema',
    publication: 'tts_cli',
    slot: 'tts_cli',
    ownershipToken: '0123456789abcdef0123456789abcdef',
    tables: [{ namespace: 'public', name: 'items' }],
  };
}
export async function sourceCli(
  root: string,
  command: string,
  env: NodeJS.ProcessEnv = {},
  options: readonly string[] = [],
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (done, reject) => {
      execFile(
        process.execPath,
        [
          resolve('apps/cli/dist/bin.js'),
          command,
          'source.json',
          '--json',
          ...options,
        ],
        {
          cwd: root,
          env: { ...process.env, TTS_WORKSPACE: undefined, ...env },
          timeout: 15000,
          maxBuffer: 2 * 1048576,
        },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') {
            reject(error);
            return;
          }
          done({
            code: typeof error?.code === 'number' ? error.code : 0,
            stdout,
            stderr,
          });
        },
      );
    },
  );
}
