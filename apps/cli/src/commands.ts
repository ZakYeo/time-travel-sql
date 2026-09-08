import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  HistoryError,
  decodePosition,
  decodeSavedCheck,
} from '@time-travel-sql/sdk';
import {
  createLocalExporter,
  openLocalStore,
} from '@time-travel-sql/storage-local';
import {
  exportRecordingFile,
  importRecordingFile,
} from '@time-travel-sql/exchange';
import { boundedInteger, isSourceCommand, UsageError } from './arguments.js';
import type { argumentsFor } from './arguments.js';
import { owned } from './owned.js';
import { investigate } from './investigate.js';
import { queryHistory } from './query.js';
import { scanCheck } from './scan.js';
import { sourceCommand } from './source.js';

type Command = Extract<ReturnType<typeof argumentsFor>, { kind: 'command' }>;

export function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new HistoryError('CANCELLED', 'Command cancelled.');
}

export async function execute(
  command: Command,
  workspace: string | undefined,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  env: Readonly<Record<string, string | undefined>>,
): Promise<unknown> {
  checkCancellation(signal);
  if (isSourceCommand(command.command))
    return sourceCommand(
      command.command,
      command.operands[0] ?? '',
      cwd,
      env,
      signal,
    );
  if (!workspace) throw new UsageError('A workspace is required.');
  const path = join(workspace, 'history.sqlite');
  if (command.command === 'init')
    await mkdir(workspace, { recursive: true, mode: 0o700 });
  else if (!(await stat(path)).isFile())
    throw new HistoryError(
      'STORAGE_FAILURE',
      'Workspace database must be a regular file.',
    );
  checkCancellation(signal);
  if (command.command === 'scan-check')
    return scanCheck(
      path,
      command.operands,
      command.options,
      timeoutMs,
      signal,
    );
  if (command.command === 'query')
    return queryHistory(
      path,
      command.operands,
      command.options,
      timeoutMs,
      signal,
    );
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
      case 'save-check':
        return store.saveCheck(
          id,
          decodeSavedCheck({
            id: argument,
            name: command.operands[2],
            query: { sql: command.operands[3] },
          }),
        );
      case 'show-check':
        return store.savedCheck(id, argument);
      case 'list-checks':
        return store.savedChecks(id, {
          limit: boundedInteger(command.options.limit ?? '50', 100),
          cursor: command.options.cursor ?? null,
        });
      case 'remove-check':
        await store.removeCheck(id, argument);
        return { removed: argument, recordingId: id };
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
