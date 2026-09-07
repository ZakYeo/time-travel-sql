import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { withPostgres } from '../../test-support/postgres.js';

it('stops an owned postmaster even when the startup command reports failure after launch', async () => {
  const binaries = process.env.TTS_PG_BIN ?? '/usr/lib/postgresql/16/bin';
  const wrapper = await mkdtemp(join(tmpdir(), 'tts-pg-start-failure-'));
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const pidFile = join(wrapper, 'started-pid');
  const dataFile = join(wrapper, 'started-data');
  try {
    await symlink(join(binaries, 'initdb'), join(wrapper, 'initdb'));
    await writeFile(
      join(wrapper, 'pg_ctl'),
      `#!/bin/sh
${quote(join(binaries, 'pg_ctl'))} "$@"
tts_status=$?
case " $* " in
  *" start "*)
    if test "$tts_status" -eq 0; then
      head -n 1 "$2/postmaster.pid" > ${quote(pidFile)}
      printf '%s' "$2" > ${quote(dataFile)}
      exit 1
    fi
    ;;
esac
exit "$tts_status"
`,
      { mode: 0o700 },
    );
    vi.stubEnv('TTS_PG_BIN', wrapper);
    await expect(
      withPostgres(async () => {
        throw new Error('Work must not start.');
      }),
    ).rejects.toMatchObject({ code: 1 });
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    const data = await readFile(dataFile, 'utf8');
    expect(() => process.kill(pid, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );
    await expect(access(data)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    vi.unstubAllEnvs();
    await rm(wrapper, { recursive: true, force: true });
  }
});
