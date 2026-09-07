import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('keeps architecture and Semgrep scans and fixtures in both quality hooks', async () => {
  const manifest: unknown = JSON.parse(await readFile('package.json', 'utf8'));
  expect(manifest).toHaveProperty('scripts.check');
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('scripts' in manifest)
  )
    throw new Error('Missing scripts');
  const scripts = manifest.scripts;
  if (typeof scripts !== 'object' || scripts === null || !('check' in scripts))
    throw new Error('Missing check');
  expect(scripts.check).toEqual(
    expect.stringContaining('npm run architecture'),
  );
  expect(scripts.check).toEqual(expect.stringContaining('npm run semgrep &&'));
  expect(scripts.check).toEqual(
    expect.stringContaining('npm run semgrep:test'),
  );
  for (const hook of ['pre-commit', 'pre-push']) {
    expect(await readFile(`.githooks/${hook}`, 'utf8')).toContain(
      'npm run check',
    );
  }
});

it.each([
  ['feat(sdk): add exact positions', 0],
  ['fix: reject invalid history', 0],
  ['misc changes', 1],
  ['', 1],
])('validates commit subject %j', async (subject, status) => {
  const root = await mkdtemp(join(tmpdir(), 'tts-commit-'));
  try {
    const path = join(root, 'message');
    await writeFile(path, `${subject}\n`);
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/commit-message.mjs'), path],
      { encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    expect(result.status).toBe(status);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
