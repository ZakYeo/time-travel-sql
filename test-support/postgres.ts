import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresConnection } from '@time-travel-sql/source-postgres';
import { cleanupPostgres } from './postgres-cleanup.js';

const run = promisify(execFile);

/** Creates only a private disposable native cluster; never reads DATABASE_URL. */
export async function withPostgres<T>(
  work: (connection: PostgresConnection) => Promise<T>,
): Promise<T> {
  const binaries = process.env.TTS_PG_BIN ?? '/usr/lib/postgresql/16/bin';
  const root = await mkdtemp(join(tmpdir(), 'tts-pg-'));
  const data = join(root, 'data');
  let startAttempted = false;
  let primaryFailure: unknown;
  try {
    await run(
      join(binaries, 'initdb'),
      [
        '-D',
        data,
        '-U',
        'tts_test',
        '--auth-local=trust',
        '--auth-host=reject',
        '--no-locale',
        '--encoding=UTF8',
      ],
      { timeout: 30000 },
    );
    const socket = `'${root.replaceAll("'", "'\\''")}'`;
    startAttempted = true;
    await run(
      join(binaries, 'pg_ctl'),
      [
        '-D',
        data,
        '-l',
        join(root, 'postgres.log'),
        '-o',
        `-h '' -k ${socket} -c wal_level=logical -c max_replication_slots=8 -c max_wal_senders=8`,
        '-w',
        '-t',
        '15',
        'start',
      ],
      { timeout: 20000 },
    );
    return await work({
      host: root,
      port: 5432,
      user: 'tts_test',
      database: 'postgres',
    });
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    await cleanupPostgres(root, binaries, startAttempted, primaryFailure);
  }
}
