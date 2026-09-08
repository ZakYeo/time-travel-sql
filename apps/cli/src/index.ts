import { HistoryError } from '@time-travel-sql/sdk';
import { argumentsFor, boundedInteger, help, UsageError } from './arguments.js';
import { deadline } from './deadline.js';
import { configuration } from './configuration.js';
import { checkCancellation, execute } from './commands.js';

export interface CliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly stdout: (text: string, signal: AbortSignal) => Promise<void>;
  readonly stderr: (text: string, signal: AbortSignal) => Promise<void>;
}

/** Importing this module does not read environment or install process listeners. */
export async function runCli(
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  const separator = argv.indexOf('--');
  let json = argv
    .slice(0, separator < 0 ? argv.length : separator)
    .includes('--json');
  let operation: ReturnType<typeof deadline> | undefined;
  try {
    const command = argumentsFor(argv);
    json =
      command.kind === 'help' ? command.json : (command.options.json ?? false);
    if (command.kind === 'help') {
      await context.stdout(
        json
          ? JSON.stringify({ version: 1, ok: true, data: { help } }) + '\n'
          : help,
        context.signal,
      );
      return 0;
    }
    checkCancellation(context.signal);
    operation = deadline(
      context.signal,
      boundedInteger(
        command.options['timeout-ms'] ?? context.env.TTS_TIMEOUT_MS ?? '30000',
        3600000,
      ),
    );
    const config = await configuration(
      command.options,
      context.cwd,
      context.env,
      operation.signal,
    );
    operation.setBudget(config.timeoutMs);
    const signal = operation.signal;
    const data = await execute(
      command,
      config.workspace,
      context.cwd,
      signal,
      config.timeoutMs,
    );
    if (
      [
        'list',
        'inspect',
        'validate',
        'transaction',
        'rows',
        'compare',
        'query',
      ].includes(command.command)
    )
      checkCancellation(signal);
    // Result delivery can fail after a mutation commits. Cancellation is not
    // a claim that the completed mutation was rolled back.
    await context.stdout(
      JSON.stringify(
        json ? { version: 1, ok: true, data } : data,
        null,
        json ? undefined : 2,
      ) + '\n',
      signal,
    );
    return 0;
  } catch (error) {
    const cancelled =
      (error instanceof HistoryError && error.code === 'CANCELLED') ||
      (operation?.signal.aborted && error === operation.signal.reason);
    const code =
      error instanceof UsageError
        ? 'USAGE'
        : cancelled
          ? operation?.timedOut()
            ? 'TIMEOUT'
            : 'CANCELLED'
          : error instanceof HistoryError
            ? error.code
            : 'STORAGE_FAILURE';
    const exitCode =
      code === 'USAGE'
        ? 2
        : code === 'TIMEOUT'
          ? 124
          : code === 'CANCELLED'
            ? 130
            : 1;
    const message =
      error instanceof UsageError || error instanceof HistoryError
        ? error.message
        : 'Command failed; no raw driver or filesystem details are displayed.';
    await context.stderr(
      json
        ? JSON.stringify({ version: 1, ok: false, error: { code, message } }) +
            '\n'
        : `${code}: ${message}\n`,
      AbortSignal.timeout(1000),
    );
    return exitCode;
  } finally {
    operation?.close();
  }
}
