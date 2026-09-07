import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const roots = ['packages', 'apps'].filter(existsSync).flatMap((root) =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${root}/${entry.name}/src`)
    .filter(existsSync),
);
if (existsSync('examples')) roots.push('examples');
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
