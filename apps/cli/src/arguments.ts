import { commands } from './command-catalog.js';
import type { CommandName } from './command-catalog.js';
export { isSourceCommand } from './command-catalog.js';
import {
  MAX_QUERY_LIMITS,
  MAX_ROW_HISTORY_OPTIONS,
  DEFAULT_QUERY_LIMITS,
  MAX_SCAN_LIMITS,
  DEFAULT_SCAN_LIMITS,
} from '@time-travel-sql/sdk';
import { parseArgs } from 'node:util';

export class UsageError extends Error {}

export function argumentsFor(argv: readonly string[]) {
  if (argv.length > 64 || argv.some((value) => value.length > 65536))
    throw new UsageError('Command arguments exceed their bounds.');
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        workspace: { type: 'string' },
        config: { type: 'string' },
        'timeout-ms': { type: 'string' },
        limit: { type: 'string' },
        cursor: { type: 'string' },
        offset: { type: 'string' },
        'max-states': { type: 'string' },
        'duration-ms': { type: 'string' },
      },
      tokens: true,
    });
  } catch (cause) {
    throw new UsageError('Invalid command options. Run tts --help.', { cause });
  }
  const names = parsed.tokens
    .filter((token) => token.kind === 'option')
    .map((token) => token.name);
  if (new Set(names).size !== names.length)
    throw new UsageError('Repeated options are not supported.');
  if (parsed.values.help || !argv.length)
    return { kind: 'help' as const, json: parsed.values.json ?? false };
  const [name, ...operands] = parsed.positionals;
  if (!name || !Object.hasOwn(commands, name))
    throw new UsageError('Unknown command. Run tts --help.');
  // Own-key validation establishes the finite command boundary.
  const command = name as CommandName;
  if (parsed.values.limit !== undefined)
    boundedInteger(
      parsed.values.limit,
      command === 'query' || command === 'scan-check'
        ? MAX_QUERY_LIMITS.maxRows
        : 100,
    );
  if (operands.length !== commands[command].arity)
    throw new UsageError(`Usage: tts ${commands[command].usage}`);
  if (
    parsed.values.limit !== undefined &&
    ![
      'list',
      'list-checks',
      'rows',
      'compare',
      'query',
      'scan-check',
      'row-history',
    ].includes(command)
  )
    throw new UsageError(
      'Limits apply only to list, list-checks, rows, compare, query, scan-check and row-history.',
    );
  if (
    parsed.values.cursor !== undefined &&
    !['list', 'list-checks'].includes(command)
  )
    throw new UsageError('Cursors apply only to list and list-checks.');
  if (parsed.values['max-states'] !== undefined) {
    if (command !== 'scan-check')
      throw new UsageError('State limits apply only to scan-check.');
    boundedInteger(parsed.values['max-states'], MAX_SCAN_LIMITS.maxStates);
  }
  if (parsed.values['duration-ms'] !== undefined) {
    if (command !== 'record' && command !== 'resume')
      throw new UsageError('Duration applies only to record and resume.');
    boundedInteger(parsed.values['duration-ms'], 3600000);
  }
  if (parsed.values.offset !== undefined) {
    if (!['rows', 'compare', 'row-history'].includes(command))
      throw new UsageError(
        'Offsets apply only to rows, compare and row-history.',
      );
    if (parsed.values.offset !== '0')
      boundedInteger(
        parsed.values.offset,
        command === 'row-history' ? MAX_ROW_HISTORY_OPTIONS.offset : 2000000,
      );
  }
  return {
    kind: 'command' as const,
    command,
    operands,
    options: parsed.values,
  };
}

export function boundedInteger(value: string, maximum: number): number {
  if (
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > maximum
  )
    throw new UsageError(
      'Expected a positive integer within the documented limit.',
    );
  return Number(value);
}

export const help = `Usage: tts COMMAND [options]

${Object.values(commands)
  .map((item) => `  ${item.usage}\n    ${item.description}`)
  .join('\n')}

Options:
  --workspace DIR   Local workspace directory (required for recording commands).
  --config FILE     JSON configuration with workspace and timeoutMs fields.
  --timeout-ms N    Cancellation deadline, 1–3600000 ms (default 30000).
  --duration-ms N   Stop capture successfully after 1–3600000 ms of session time.
  --json            Emit a versioned JSON result or error, one line per command.
  --limit N         List/list-checks/rows/compare/row-history page size, 1–100 (default 50).
                    Query/scan SQL row cap, 1–${MAX_QUERY_LIMITS.maxRows} (default ${DEFAULT_QUERY_LIMITS.maxRows}); no truncation.
  --offset N        Rows/compare/row-history match offset, 0–2000000 (default 0).
  --cursor TOKEN    Opaque continuation token from a previous list result.
  --max-states N    Scan evaluation cap, 1–${MAX_SCAN_LIMITS.maxStates} (default ${DEFAULT_SCAN_LIMITS.maxStates}).
  -h, --help        Show this help without opening a workspace.

Precedence: command flags > TTS_WORKSPACE/TTS_TIMEOUT_MS > explicit config > defaults.
Relative CLI/environment paths use the working directory; config workspace uses
the config file directory. No source passwords are accepted in command arguments.

Examples:
  tts init --workspace ./history
  tts record session 'Order investigation' ./source.json --workspace ./history --duration-ms 60000 --timeout-ms 90000
  tts resume session ./source.json --workspace ./history --duration-ms 60000 --timeout-ms 90000
  tts import ./recording.tts --workspace ./history --json
  tts list --workspace ./history --limit 20 --json
  tts export recording-id ./shared.tts --workspace ./history
  tts rows recording-id orders after:10 --workspace ./history --json
  tts compare recording-id orders baseline after:10 --workspace ./history --json
  tts query recording-id after:10 "SELECT count(*) FROM public.orders" --workspace ./history --json
  tts save-check recording-id negative "Negative balances" "SELECT * FROM accounts WHERE balance < 0" --workspace ./history
  tts scan-check recording-id negative baseline after:10 --workspace ./history --json

Historical SQL has a separate engine budget capped at ${MAX_QUERY_LIMITS.timeoutMs} ms,
within the overall command deadline. Query resource-limit failures exit 1 with
LIMIT_EXCEEDED; expiry of the command deadline exits 124 with TIMEOUT.
SQL is at most 64 KiB; default result limits include 128 columns, 1 MiB per cell
and 8 MiB compact result JSON. A query never returns a truncated success.
Saved definitions are local, recording-scoped and replaced explicitly by save-check.
Scan findings are first observed violations, not proof of business causality.
Scan success (exit 0) reports clear or violation; incomplete work exits 1, 124 or
130 and includes range/progress on stderr. Preparation cancellation reports requested
selections and zero evaluations. --timeout-ms covers opening history and every query.
The per-query engine cap still applies. See docs/invariant-scans.md for replay,
aggregate input, event and diff limits. Saved checks are not included in portable exports.

Capture requires explicit source setup and retains slots on stop. Duration includes
session acquisition/retries; the command deadline also includes bootstrap. Capture
progress goes to stderr; final results go to stdout. See docs/source-cli.md.

Exit codes: 0 success; 1 operation failure; 2 usage/config error;
124 timeout; 130 cancellation. Results go to stdout; errors go to stderr.
Cancellation drains owned cleanup. Completed mutations are not rolled back if
cancellation arrives after their commit. Missing workspaces require tts init.
`;
