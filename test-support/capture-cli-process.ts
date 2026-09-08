import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';

/** Owns one actual CLI process and bounded captured output. */
export function captureCli(root: string, args: readonly string[]) {
  const child = spawn(
    process.execPath,
    [
      resolve('apps/cli/dist/bin.js'),
      ...args,
      '--workspace',
      join(root, 'history'),
      '--json',
      '--timeout-ms',
      '15000',
    ],
    {
      cwd: root,
      env: { ...process.env, TTS_TEST_SOURCE_PASSWORD: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  let overflow = false;
  const append = (current: string, chunk: Buffer) => {
    if (Buffer.byteLength(current) + chunk.length > 2 * 1048576) {
      overflow = true;
      child.kill('SIGKILL');
      return current;
    }
    return current + chunk.toString('utf8');
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20000);
  const done = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      if (overflow || signal)
        reject(new Error('CLI exceeded process/output bounds.'));
      else done({ code, stdout, stderr });
    });
  });
  void done.catch(() => {
    /* The process owner awaits completion. */
  });
  return {
    child,
    done,
    async close() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGINT');
      await done;
    },
  };
}
