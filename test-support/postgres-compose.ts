import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PostgresConnection } from '@time-travel-sql/source-postgres';

const run = promisify(execFile);

/** One fresh local Compose project per invocation. No ambient database or Docker context. */
export async function withComposePostgres<T>(
  work: (connection: PostgresConnection) => Promise<T>,
): Promise<T> {
  const socket = process.env.TTS_DOCKER_SOCKET ?? '/var/run/docker.sock';
  if (!isAbsolute(socket))
    throw new Error('TTS_DOCKER_SOCKET must be an absolute local socket path.');
  const project = 'tts-test-' + randomUUID().replaceAll('-', '');
  const config = await mkdtemp(join(tmpdir(), 'tts-compose-client-'));
  const file = fileURLToPath(
    new URL('../compose.postgres.yml', import.meta.url),
  );
  const compose = (args: readonly string[], timeout = 120000) =>
    run(
      'docker',
      [
        '--config',
        config,
        '--host',
        'unix://' + socket,
        'compose',
        '--project-name',
        project,
        '--file',
        file,
        ...args,
      ],
      { timeout, maxBuffer: 1024 * 1024 },
    );
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  try {
    await compose([
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '60',
      'postgres',
    ]);
    const endpoint = (
      await compose(['port', 'postgres', '5432'], 10000)
    ).stdout.trim();
    const match = /^127\.0\.0\.1:([0-9]{1,5})$/.exec(endpoint);
    const port = Number(match?.[1]);
    if (!match || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(
        'Compose did not publish exactly one loopback PostgreSQL port.',
      );
    outcome = {
      ok: true,
      value: await work({
        host: '127.0.0.1',
        port,
        user: 'tts_dev',
        database: 'tts_dev',
        password: 'tts_disposable_local_only',
      }),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const failures: unknown[] = [];
  try {
    await compose(['down', '--volumes', '--timeout', '10'], 30000);
  } catch (error) {
    failures.push(error);
  }
  try {
    await rm(config, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(
      outcome.ok ? failures : [outcome.error, ...failures],
      `Compose fixture cleanup failed for ${project}.`,
    );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
