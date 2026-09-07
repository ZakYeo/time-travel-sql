import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('Missing commit message file');
const subject = readFileSync(path, 'utf8').split('\n')[0];
if (
  !/^(feat|fix|docs|test|refactor|build|ci|chore|perf)(\([a-z0-9-]+\))?!?: .{1,100}$/.test(
    subject ?? '',
  )
) {
  console.error('Use a Conventional Commit: feat(sdk): describe the change');
  process.exitCode = 1;
}
