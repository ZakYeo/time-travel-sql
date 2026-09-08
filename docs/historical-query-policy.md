# Historical SQL engine evidence

This is a feasibility milestone, not a production query adapter or a complete
SQL sandbox. `npm run test:query-policy` is part of both Git hooks through
`npm run check`. Four tests exercise the pinned PGlite 0.5.8 engine, which reports
PostgreSQL 18.3, using owned in-memory fixtures without source connections.

## Observed boundary

PGlite's `username` option alone is insufficient: loading an owner-created data
directory as `tts_reader` changes `current_user` but leaves `session_user` as
`postgres`. `RESET ROLE` restores the owner. A regression test preserves this
finding; production isolation must not rely on that option.

The stronger fixture creates a restricted reader, revokes public database/schema
privileges and catalog function execution, then grants table reads and a small
function allowlist plus pristine catalog operator implementations. It sets session
authorization to the reader. Each query runs inside a trusted read-only transaction
through `DECLARE ... CURSOR FOR` using the single-statement extended protocol,
fetches two rows, and rolls back. PostgreSQL grammar, permissions and transaction
mode jointly constrain the query; there is no SELECT-prefix regular expression.

Tests reject DML, writable CTEs, multiple statements, transaction/role commands,
DDL, COPY, extensions, SELECT INTO and row locks. Configuration, dynamic SQL,
file-reading, large-object and notification functions must fail with permission
SQLSTATE `42501`. A fixed test-only security-definer function attempts an update
and must fail with read-only SQLSTATE `25006`. After every rejection, the original
rows and reader identity must remain intact. This privileged function is only an
attack fixture; source functions must never be installed in historical workspaces.

Joins, aggregates and a SELECT CTE work. Explicit text parsers preserve the tested
numeric, JSON integer and microsecond timestamp representations. This is evidence
for those cases, not complete supported-type coverage. Setup and query cleanup
retain primary and cleanup errors together.

## Execution and remaining work

Bundled engine initialization and SELECT work with global fetch disabled. This
checks the tested loader path, not every possible network mechanism. The default
in-memory filesystem is used; no host filesystem adapter or extension is registered.
The [PGlite API](https://pglite.dev/docs/api) and
[filesystem documentation](https://pglite.dev/docs/filesystems) describe these
embedding options.

An owned worker runs a deliberately expensive aggregate while the parent processes
five timers, then terminates it. Unexpected completion, early exit and failure to
terminate within the watchdog budget fail the test. This demonstrates responsive
parent cancellation on the tested runtime; a worker is not an OS security sandbox.

Cursor fetch bounds returned row count only. Cell size, total result bytes,
intermediate materialization, execution budgets and WASM memory still need a
production design and evidence. JavaScript worker heap limits do not establish a
hard WASM memory limit. The production adapter also needs validated schema/value
materialization, complete exact result handling, explicit unavailable-column
failures, public SDK contracts and CLI composition. None is claimed complete by
this fixture. The original bootstrap authentication authority makes the grammar
and function restrictions essential even after session authorization changes.
