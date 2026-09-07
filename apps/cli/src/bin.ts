#!/usr/bin/env node
import { runCli } from './index.js';
import { HistoryError } from '@time-travel-sql/sdk';

const controller = new AbortController();
let cancelledOutput = false;
const cancel = () => controller.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
// The callback rejects the write; these listeners also own its error event.
process.stdout.on('error', cancel);
process.stderr.on('error', cancel);
function write(
  stream: NodeJS.WriteStream,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      cancelledOutput = true;
      stream.destroy();
      finish(
        new HistoryError(
          'CANCELLED',
          'Output delivery cancelled; a completed mutation may remain committed.',
        ),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else stream.write(text, finish);
  });
}
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    signal: controller.signal,
    stdout: (text, signal) => write(process.stdout, text, signal),
    stderr: (text, signal) => write(process.stderr, text, signal),
  });
} catch {
  process.exitCode = 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
// Node's process stdout/stderr can retain a pending native pipe write even
// after destroy(). runCli has drained database/file cleanup and attempted its
// bounded diagnostic write; only abandoned output remains at this point.
if (cancelledOutput)
  process.exit(typeof process.exitCode === 'number' ? process.exitCode : 1);
