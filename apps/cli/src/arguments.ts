import { parseArgs } from 'node:util';

export class UsageError extends Error {}

export const commands = {
  rows: {
    arity: 3,
    usage: 'rows ID TABLE SELECTION [--limit N] [--offset N]',
    description:
      'Inspect recorded rows at baseline, before:POSITION or after:POSITION.',
  },
  compare: {
    arity: 4,
    usage: 'compare ID TABLE FROM TO [--limit N] [--offset N]',
    description:
      'Compare two committed selections from one recording snapshot.',
  },
  init: {
    arity: 0,
    usage: 'init',
    description: 'Create or open a local workspace.',
  },
  list: {
    arity: 0,
    usage: 'list [--limit N] [--cursor TOKEN]',
    description: 'List one bounded page of recordings.',
  },
  inspect: {
    arity: 1,
    usage: 'inspect ID',
    description: 'Show recording metadata and coverage.',
  },
  validate: {
    arity: 1,
    usage: 'validate ID',
    description: 'Replay and validate all authoritative recorded history.',
  },
  rename: {
    arity: 2,
    usage: 'rename ID NAME',
    description: 'Change a recording name locally.',
  },
  remove: {
    arity: 1,
    usage: 'remove ID',
    description: 'Delete this local recording; retain source resources.',
  },
  export: {
    arity: 2,
    usage: 'export ID FILE',
    description: 'Publish a complete portable file without overwriting.',
  },
  import: {
    arity: 1,
    usage: 'import FILE',
    description: 'Validate a portable file and publish atomically.',
  },
  transaction: {
    arity: 2,
    usage: 'transaction ID POSITION',
    description: 'Show one committed transaction at an exact decimal position.',
  },
} as const;
export type CommandName = keyof typeof commands;

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
    boundedInteger(parsed.values.limit, 100);
  if (operands.length !== commands[command].arity)
    throw new UsageError(`Usage: tts ${commands[command].usage}`);
  if (
    parsed.values.limit !== undefined &&
    !['list', 'rows', 'compare'].includes(command)
  )
    throw new UsageError('Limits apply only to list, rows and compare.');
  if (parsed.values.cursor !== undefined && command !== 'list')
    throw new UsageError('Cursors apply only to list.');
  if (parsed.values.offset !== undefined) {
    if (!['rows', 'compare'].includes(command))
      throw new UsageError('Offsets apply only to rows and compare.');
    if (parsed.values.offset !== '0')
      boundedInteger(parsed.values.offset, 2000000);
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
  --workspace DIR   Local workspace directory (required through flags/env/config).
  --config FILE     JSON configuration with workspace and timeoutMs fields.
  --timeout-ms N    Cancellation deadline, 1–3600000 ms (default 30000).
  --json            Emit a versioned JSON result or error, one line per command.
  --limit N         List/rows/compare page size, 1–100 (default 50).
  --offset N        Rows/compare match offset, 0–2000000 (default 0).
  --cursor TOKEN    Opaque continuation token from a previous list result.
  -h, --help        Show this help without opening a workspace.

Precedence: command flags > TTS_WORKSPACE/TTS_TIMEOUT_MS > explicit config > defaults.
Relative CLI/environment paths use the working directory; config workspace uses
the config file directory. No source passwords are accepted in command arguments.

Examples:
  tts init --workspace ./history
  tts import ./recording.tts --workspace ./history --json
  tts list --workspace ./history --limit 20 --json
  tts export recording-id ./shared.tts --workspace ./history
  tts rows recording-id orders after:10 --workspace ./history --json
  tts compare recording-id orders baseline after:10 --workspace ./history --json

Exit codes: 0 success; 1 operation failure; 2 usage/config error;
124 timeout; 130 cancellation. Results go to stdout; errors go to stderr.
Cancellation drains owned cleanup. Completed mutations are not rolled back if
cancellation arrives after their commit. Missing workspaces require tts init.
`;
