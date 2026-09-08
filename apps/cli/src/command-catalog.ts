export const commands = {
  sample: {
    arity: 0,
    usage: 'sample',
    description:
      'Create a workspace if needed and load the bundled checkout sample without a source connection.',
  },
  'export-derived': {
    arity: 5,
    usage: 'export-derived ID FILE DERIVED_ID NAME POLICY',
    description:
      'Export a separately identified column-policy projection with declared capabilities.',
  },
  'row-history': {
    arity: 4,
    usage: 'row-history ID TABLE SELECTION KEY [--limit N] [--offset N]',
    description:
      'Follow one recorded row across updates, key changes and deletion from an explicit anchor.',
  },
  record: {
    arity: 3,
    usage: 'record ID NAME SOURCE_CONFIG [--duration-ms N]',
    description:
      'Capture a new baseline and committed changes using explicit existing source setup.',
  },
  resume: {
    arity: 2,
    usage: 'resume ID SOURCE_CONFIG [--duration-ms N]',
    description:
      'Resume a bound recording from retained source resources; never create replacement slots.',
  },
  'source-plan': {
    scope: 'source',
    arity: 1,
    usage: 'source-plan SOURCE_CONFIG',
    description:
      'Generate inspectable setup SQL without connecting or creating resources.',
  },
  'source-setup': {
    scope: 'source',
    arity: 1,
    usage: 'source-setup SOURCE_CONFIG',
    description:
      'Explicitly apply table/publication setup; never replace an existing publication or slot.',
  },
  'source-inspect': {
    scope: 'source',
    arity: 1,
    usage: 'source-inspect SOURCE_CONFIG',
    description: 'Read and validate the configured setup ownership receipt.',
  },
  'source-doctor': {
    scope: 'source',
    arity: 1,
    usage: 'source-doctor SOURCE_CONFIG',
    description:
      'Check configured capture prerequisites without creating resources.',
  },
  'save-check': {
    arity: 4,
    usage: 'save-check ID CHECK NAME SQL',
    description:
      'Create or replace a saved SQL violation check locally; does not execute SQL.',
  },
  'show-check': {
    arity: 2,
    usage: 'show-check ID CHECK',
    description: 'Show one saved SQL definition and query limits.',
  },
  'list-checks': {
    arity: 1,
    usage: 'list-checks ID [--limit N] [--cursor TOKEN]',
    description: 'List saved checks for a recording.',
  },
  'remove-check': {
    arity: 2,
    usage: 'remove-check ID CHECK',
    description: 'Remove one local saved SQL definition.',
  },
  'scan-check': {
    arity: 4,
    usage: 'scan-check ID CHECK FROM TO [--max-states N] [--limit N]',
    description:
      'Find the first observed violation chronologically across an inclusive committed range.',
  },
  query: {
    arity: 3,
    usage: 'query ID SELECTION SQL [--limit N]',
    description:
      'Run read-only SQL on an explicit committed state; limits fail without partial output.',
  },
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

export function isSourceCommand(
  command: CommandName,
): command is Extract<CommandName, `source-${string}`> {
  const definition = commands[command];
  return 'scope' in definition && definition.scope === 'source';
}
