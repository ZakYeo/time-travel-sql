import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
for (const file of new Set(files)) {
  if (file === 'GOAL.md' || file === 'package-lock.json') continue;
  const text = readFileSync(file, 'utf8');
  if (/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(text))
    throw new Error(`Private key in ${file}`);
  if (/postgres(?:ql)?:\/\/[^\s/:]+:[^\s@]+@/.test(text))
    throw new Error(`Credential URL in ${file}`);
  if (
    file.includes('/src/') &&
    file.endsWith('.ts') &&
    text.split('\n').length > 500
  )
    throw new Error(`Decompose ${file}: exceeds 500 lines`);
}
console.log('Secret and module-size checks passed.');
