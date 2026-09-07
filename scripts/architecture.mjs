import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const roots = ['packages', 'apps', 'examples'].filter(existsSync);
const result = spawnSync(
  process.execPath,
  [
    'node_modules/dependency-cruiser/bin/dependency-cruise.mjs',
    ...roots,
    '--config',
    '.dependency-cruiser.mjs',
  ],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
