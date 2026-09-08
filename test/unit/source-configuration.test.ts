import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  sourceConfig,
  sourceCli,
} from '../../test-support/source-cli-fixture.js';
import {
  sourceConfiguration,
  sourceConnection,
} from '../../apps/cli/dist/source-configuration.js';

it('generates quoted setup offline without credentials or workspace mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-source-config-'));
  try {
    await writeFile(
      join(root, 'source.json'),
      JSON.stringify({
        ...sourceConfig(),
        tables: [{ namespace: 'odd.schema', name: 'a"b' }],
      }),
    );
    const result = await sourceCli(root, 'source-plan', {
      TTS_TEST_SOURCE_PASSWORD: undefined,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: {
        slot: 'tts_cli',
        sql: expect.stringContaining('"odd.schema"."a""b"'),
      },
    });
    expect(result.stdout).not.toContain('invalid.example');
    await expect(stat(join(root, 'not-created'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('requires explicit bounded connection, TLS and secret references without accepting inline passwords', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-source-config-'));
  const path = join(root, 'source.json');
  try {
    const config = sourceConfig();
    for (const connection of [
      { ...config.connection, password: 'do-not-print-this' },
      { ...config.connection, sslMode: 'prefer' },
      { ...config.connection, port: 0 },
      { ...config.connection, host: '' },
      { ...config.connection, passwordEnv: 'INVALID-NAME' },
    ]) {
      await writeFile(path, JSON.stringify({ ...config, connection }));
      const result = await sourceCli(root, 'source-plan');
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('do-not-print-this');
    }
    await writeFile(
      path,
      JSON.stringify({
        ...config,
        connection: { ...config.connection, sslMode: 'verify-full' },
      }),
    );
    const decoded = await sourceConfiguration(
      path,
      new AbortController().signal,
    );
    expect(() => sourceConnection(decoded, { PGPASSWORD: 'ambient' })).toThrow(
      'missing or invalid',
    );
    expect(
      sourceConnection(decoded, { TTS_TEST_SOURCE_PASSWORD: 'explicit' }),
    ).toMatchObject({
      password: 'explicit',
      ssl: { rejectUnauthorized: true },
    });
    await writeFile(path, ' '.repeat(65537));
    expect((await sourceCli(root, 'source-plan')).code).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
