import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
it('reproduces the bundled portable sample byte for byte and ships it in the CLI package', async () => {
  await execute(
    process.execPath,
    ['scripts/generate-checkout-sample.mjs', '--check'],
    { timeout: 15000 },
  );
  const cache = await mkdtemp(join(tmpdir(), 'tts-sample-cache-'));
  try {
    const result = await execute(
      'npm',
      [
        'pack',
        '--workspace',
        '@time-travel-sql/cli',
        '--dry-run',
        '--json',
        '--cache',
        cache,
      ],
      { timeout: 15000 },
    );
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'assets/checkout.tts' }),
        ]),
      }),
    ]);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}, 30000);
