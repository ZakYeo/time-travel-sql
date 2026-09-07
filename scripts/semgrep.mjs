import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporary = mkdtempSync(join(tmpdir(), 'tts-semgrep-'));
try {
  const env = {
    ...process.env,
    SEMGREP_SETTINGS_FILE: join(temporary, 'settings.yml'),
    SEMGREP_LOG_FILE: join(temporary, 'semgrep.log'),
    SEMGREP_ENABLE_VERSION_CHECK: '0',
    SEMGREP_SEND_METRICS: 'off',
  };
  delete env.SEMGREP_APP_TOKEN;
  const args =
    process.argv[2] === 'test'
      ? [
          '--test',
          '--config',
          '.semgrep/maintainability.yml',
          'test/semgrep/packages/sdk/src/maintainability.ts',
          '--metrics=off',
          '--disable-version-check',
        ]
      : [
          'scan',
          '--config',
          '.semgrep/maintainability.yml',
          '--error',
          '--strict',
          '--metrics=off',
          '--disable-version-check',
          '--exclude',
          'test/semgrep',
          '--exclude',
          'node_modules',
          '--exclude',
          '**/dist',
          '.',
        ];
  const result = spawnSync('semgrep', args, { env, stdio: 'inherit' });
  if (result.error)
    throw new Error(
      'Semgrep is required. Install the pinned version in requirements-dev.txt.',
      { cause: result.error },
    );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
