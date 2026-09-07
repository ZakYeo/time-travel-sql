import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HistoryError, decodePosition } from '@time-travel-sql/sdk';
import {
  createLocalExporter,
  openLocalStore,
} from '@time-travel-sql/storage-local';
import {
  exportRecordingFile,
  importRecordingFile,
} from '@time-travel-sql/exchange';
import { boundedInteger } from './arguments.js';
import type { argumentsFor } from './arguments.js';
import { owned } from './owned.js';
import { investigate } from './investigate.js';

type Command = Extract<ReturnType<typeof argumentsFor>, { kind: 'command' }>;

export function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new HistoryError('CANCELLED', 'Command cancelled.');
}

export async function execute(
  command: Command,
  workspace: string,
  cwd: string,
  signal: AbortSignal,
): Promise<unknown> {
  checkCancellation(signal);
  const path = join(workspace, 'history.sqlite');
  if (command.command === 'init')
    await mkdir(workspace, { recursive: true, mode: 0o700 });
  else if (!(await stat(path)).isFile())
    throw new HistoryError(
      'STORAGE_FAILURE',
      'Workspace database must be a regular file.',
    );
  checkCancellation(signal);
  const id = command.operands[0] ?? '';
  if (command.command === 'rows' || command.command === 'compare')
    return investigate(
      path,
      command.command,
      command.operands,
      command.options,
      signal,
    );
  const argument = command.operands[1] ?? '';
  if (command.command === 'export' || command.command === 'validate') {
    return owned(createLocalExporter({ path }), async (provider) => {
      if (command.command === 'export')
        return exportRecordingFile(
          provider,
          id,
          resolve(cwd, argument),
          signal,
        );
      return owned(await provider.open(id, signal), async (session) => ({
        valid: true,
        info: session.info,
      }));
    });
  }
  return owned(await openLocalStore({ path }), async (store) => {
    checkCancellation(signal);
    switch (command.command) {
      case 'init':
        return { workspace, initialized: true };
      case 'list':
        return store.list({
          limit: boundedInteger(command.options.limit ?? '50', 100),
          cursor: command.options.cursor ?? null,
        });
      case 'inspect':
        return store.info(id);
      case 'rename':
        return store.rename(id, argument);
      case 'remove':
        await store.remove(id);
        return { removed: id };
      case 'transaction':
        return store.transaction(id, decodePosition(argument));
      case 'import':
        return importRecordingFile(resolve(cwd, id), store, signal);
      default:
        throw new HistoryError(
          'INVALID_VALUE',
          'Unsupported recording operation.',
        );
    }
  });
}
