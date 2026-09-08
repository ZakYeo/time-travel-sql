import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    'node_modules/prisma/build/index.js',
    'generate',
    '--schema',
    'examples/checkout/schema.prisma',
    '--no-hints',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      CHECKPOINT_DISABLE: '1',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
