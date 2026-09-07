import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { withComposePostgres } from '../../test-support/postgres-compose.js';

async function fakeDocker(
  work: (commands: () => Promise<string[][]>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'tts-fake-docker-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands');
  await mkdir(bin);
  await writeFile(
    join(bin, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TTS_FAKE_LOG, args.join('\\t') + '\\n');
const command = args[args.indexOf('--file') + 2];
if (command === 'port') process.stdout.write(process.env.TTS_FAKE_ENDPOINT || '127.0.0.1:35432');
if (process.env.TTS_FAKE_FAIL === command) process.exitCode = 1;
`,
    { mode: 0o700 },
  );
  vi.stubEnv('PATH', bin + ':' + process.env.PATH);
  vi.stubEnv('TTS_FAKE_LOG', log);
  vi.stubEnv('TTS_DOCKER_SOCKET', '/tmp/owned-docker.sock');
  vi.stubEnv('DOCKER_HOST', 'tcp://unrelated.invalid:2375');
  vi.stubEnv('TTS_FAKE_FAIL', '');
  vi.stubEnv('TTS_FAKE_ENDPOINT', '');
  try {
    await work(async () =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => line.split('\t')),
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}

it('uses a fresh local project and removes only its volumes and temporary client config', async () => {
  await fakeDocker(async (commands) => {
    for (let index = 0; index < 2; index++) {
      expect(
        await withComposePostgres(async (connection) => {
          expect(connection).toMatchObject({ host: '127.0.0.1', port: 35432 });
          return 'complete';
        }),
      ).toBe('complete');
    }
    const calls = await commands();
    expect(calls).toHaveLength(6);
    const projects = new Set<string>();
    for (const args of calls) {
      expect(args[args.indexOf('--host') + 1]).toBe(
        'unix:///tmp/owned-docker.sock',
      );
      const project = args[args.indexOf('--project-name') + 1];
      expect(project).toMatch(/^tts-test-[a-f0-9]{32}$/);
      if (project) projects.add(project);
      expect(args).not.toContain('--remove-orphans');
      const config = args[args.indexOf('--config') + 1];
      if (!config) throw new Error('Missing client config');
      await expect(access(config)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(projects.size).toBe(2);
    expect(calls[2]?.slice(-4)).toEqual([
      'down',
      '--volumes',
      '--timeout',
      '10',
    ]);
    expect(calls[5]?.slice(-4)).toEqual([
      'down',
      '--volumes',
      '--timeout',
      '10',
    ]);
  });
});

it.each(['up', 'endpoint', 'work'] as const)(
  'cleans its project after %s failure',
  async (failure) => {
    await fakeDocker(async (commands) => {
      if (failure === 'up') vi.stubEnv('TTS_FAKE_FAIL', 'up');
      if (failure === 'endpoint')
        vi.stubEnv('TTS_FAKE_ENDPOINT', '0.0.0.0:5432');
      const workload = vi.fn(async () => {
        throw new Error('Injected workload failure');
      });
      await expect(withComposePostgres(workload)).rejects.toThrow();
      expect(workload).toHaveBeenCalledTimes(failure === 'work' ? 1 : 0);
      const calls = await commands();
      expect(calls.at(-1)?.slice(-4)).toEqual([
        'down',
        '--volumes',
        '--timeout',
        '10',
      ]);
      expect(
        new Set(calls.map((args) => args[args.indexOf('--project-name') + 1]))
          .size,
      ).toBe(1);
    });
  },
);

it('retains workload and teardown failures together', async () => {
  await fakeDocker(async (commands) => {
    vi.stubEnv('TTS_FAKE_FAIL', 'down');
    const primary = new Error('Workload failed');
    const result = await withComposePostgres(async () => {
      throw primary;
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError))
      throw new Error('Missing aggregate');
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toBe(primary);
    const config = (await commands())[0]?.[1];
    if (!config) throw new Error('Missing client config');
    await expect(access(config)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
