import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const run = promisify(execFile);

async function isRunning(control: string, data: string): Promise<boolean> {
  try {
    await run(control, ['-D', data, 'status'], { timeout: 5000 });
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 3
    )
      return false;
    throw error;
  }
}

export async function cleanupPostgres(
  root: string,
  binaries: string,
  startAttempted: boolean,
  primaryFailure: unknown,
): Promise<void> {
  try {
    if (startAttempted) {
      const control = join(binaries, 'pg_ctl');
      const data = join(root, 'data');
      if (await isRunning(control, data)) {
        await run(
          control,
          ['-D', data, '-m', 'immediate', '-w', '-t', '15', 'stop'],
          { timeout: 20000 },
        );
      }
      if (await isRunning(control, data))
        throw new Error(
          'Owned PostgreSQL process is still running; preserving its directory.',
        );
    }
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    throw new AggregateError(
      primaryFailure === undefined ? [error] : [primaryFailure, error],
      `PostgreSQL cleanup failed; retained test directory: ${root}`,
      { cause: error },
    );
  }
}
