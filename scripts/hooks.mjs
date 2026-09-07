import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

if (process.argv[2] === 'install') {
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks']);
}
const path = execFileSync('git', ['config', '--local', 'core.hooksPath'], {
  encoding: 'utf8',
}).trim();
if (path !== '.githooks') throw new Error('Run npm run hooks:install');
for (const name of ['pre-commit', 'commit-msg', 'pre-push']) {
  accessSync(`.githooks/${name}`, constants.X_OK);
}
console.log('Repository hooks installed and executable.');
