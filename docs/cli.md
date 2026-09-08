# Recording-management CLI

Build with `npm run build`, then use `npm run tts -- --help` in this checkout.
The locally packed `@time-travel-sql/cli` installs a `tts` executable that runs
compiled JavaScript on the pinned Node runtime. Importing its `runCli` library
entry point does not install process handlers or read configuration/environment.

```sh
npm run tts -- init --workspace ./history
npm run tts -- import ./recording.tts --workspace ./history --json
npm run tts -- list --workspace ./history --limit 20 --json
npm run tts -- validate recording-id --workspace ./history
npm run tts -- export recording-id ./shared.tts --workspace ./history
```

`--help` describes every implemented command and option. Commands currently are:

| Command                        | Behavior                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `serve [--port N]`             | Start the [authenticated local API](local-api.md) until interrupted.                   |
| `sample`                       | Load the [bundled checkout sample](bundled-sample.md), creating a workspace if needed. |
| `init`                         | Create/open the workspace and versioned `history.sqlite` store.                        |
| `list`                         | Return one bounded page with an opaque `nextCursor`.                                   |
| `inspect ID`                   | Return canonical metadata and recorded coverage.                                       |
| `validate ID`                  | Replay all authoritative history using the pinned exporter.                            |
| `rename ID NAME`               | Change a local recording name.                                                         |
| `remove ID`                    | Delete the local recording, leaving source resources untouched.                        |
| `export ID FILE`               | Publish a completed portable file exclusively.                                         |
| `import FILE`                  | Validate and atomically publish a portable recording.                                  |
| `transaction ID POSITION`      | Return a complete commit at an exact decimal position.                                 |
| `rows ID TABLE SELECTION`      | Inspect one page of a selected table's recorded rows.                                  |
| `query ID SELECTION SQL`       | Execute read-only historical SQL with a hard result row cap.                           |
| `compare ID TABLE FROM TO`     | Report deterministic net differences between selected states.                          |
| `save-check ID CHECK NAME SQL` | Create or atomically replace a saved local SQL definition.                             |
| `show-check ID CHECK`          | Show the saved SQL and its query limits.                                               |
| `list-checks ID`               | List one bounded page of saved checks.                                                 |
| `remove-check ID CHECK`        | Remove one local check definition.                                                     |
| `scan-check ID CHECK FROM TO`  | Evaluate a saved SQL check chronologically in an inclusive range.                      |

Source planning/setup/inspection/doctor commands use an explicit source file and
need no workspace; see [PostgreSQL source CLI](source-cli.md).

Capture commands `record ID NAME SOURCE_CONFIG` and `resume ID SOURCE_CONFIG`
stream committed changes, report progress on stderr and stop with retained source
resources. See [capture lifecycle and examples](source-cli.md#record-stop-and-resume).

`init`, `sample` and `serve` can create a missing workspace. Other recording commands require an existing regular
database file; ordinary store commands may apply supported schema migrations.
`validate` and `export` use the read-only exporter. Local concurrency, migration
and limits follow the storage contract. Deletion is explicit and does not require
an interactive prompt, so automation must choose its workspace and ID deliberately.
`row-history ID TABLE SELECTION KEY` follows a recorded lifecycle across key changes
and deletion; see [row history](row-history.md) for anchor and paging semantics.

`rows`, `compare` and `query` are read-only and use explicit committed selections. Their
position, paging, full-validation and net-difference contracts are documented in
`docs/investigation.md`.

## Historical SQL

```sh
tts query recording-id after:10 'SELECT count(*), sum(amount) FROM public.orders' --workspace ./history --json
tts query recording-id before:10 'SELECT * FROM public.orders ORDER BY id' --limit 100 --workspace ./history
```

Use `baseline`, `before:POSITION` or `after:POSITION`; there is no implicit latest
fallback. SQL is one shell argument, at most 64 KiB of UTF-8. Quote it appropriately;
`--` ends option parsing when a literal operand starts with a dash. The result
contains `info` identifying the actual selected position, ordered `columns` with
PostgreSQL type OIDs, and ordinal `rows` containing exact text or SQL NULL. Duplicate
column names remain distinct. Control characters are JSON-escaped in both human
and machine output.

For query, `--limit` sets a hard result row cap: default 1000, maximum 10000.
Unlike row-inspection pagination, exceeding the cap fails with LIMIT_EXCEEDED and
empty stdout; it does not return a truncated success. Other SDK defaults remain:
128 result columns, 1 MiB per cell, 8 MiB compact result JSON, 200000 input rows and
128 MiB input state. The returned `info` and CLI envelope/formatting are outside
the compact result-byte budget. Cursor and offset flags are not query options;
use explicit SQL ordering/filtering as needed.

The overall command timeout includes configuration, reconstruction, SQL, resource
cleanup and output. The engine also has a separate budget equal to the configured
command timeout capped at 300000 ms, beginning when engine query work starts.
Thus a command budget above five minutes does not extend SQL execution beyond five
minutes. Overall command expiry exits 124/TIMEOUT; a query resource limit, including
its engine budget, exits 1/LIMIT_EXCEEDED. A rejected statement or unavailable-column
read exits 1/QUERY_REJECTED. Engine and reconstruction resources close before
successful output. See `historical-sql.md` for the supported policy, semantics and
remaining total-memory containment limits.

## Configuration and limits

Workspace selection is required, with this precedence:
`--workspace` > `TTS_WORKSPACE` > `workspace` in an explicitly supplied `--config`.
The timeout uses `--timeout-ms` > `TTS_TIMEOUT_MS` > config `timeoutMs` > 30000.
Config is a regular UTF-8 JSON file of at most 64 KiB; unknown fields fail.
No configuration file is implicitly discovered.

```json
{ "workspace": "./history", "timeoutMs": 30000 }
```

Relative flag/environment paths use the working directory. A relative workspace
in config uses that config file's directory. Timeouts must be integer milliseconds
from 1 to 3600000. Before config has been decoded, its I/O uses the explicit flag
or environment timeout, otherwise 30 seconds. The decoded budget includes elapsed
configuration time. Cancellation is checked between bounded config reads; arbitrary
filesystem stalls and synchronous SQLite work are not forcibly interrupted.

List pages default to 50 entries, maximum 100. Pass the returned cursor unchanged
with the same command/workspace; a null cursor marks the end. Individual commands
do not silently fetch every page. Transaction values are complete canonical tagged
values, subject to the SDK/storage bounds. Portable file limits and publication
semantics are documented in `docs/portable-recordings.md`.

Arguments are bounded to 64 tokens and 64 Ki characters per token. Duplicate
options, unknown commands/options and incompatible paging options fail. `--`
ends option parsing, allowing names such as `--json` to remain literal operands.

## Output, cancellation and automation

`--json` returns one versioned JSON envelope on stdout for success:
`{"version":1,"ok":true,"data":...}`. Errors go to stderr as
`{"version":1,"ok":false,"error":{"code":"...","message":"..."}}`.
Human output uses indented JSON for structured data and plain text diagnostics.
No raw causes, stack traces, filesystem errors or driver diagnostics are emitted.
Run the installed `tts` executable directly for CI; npm's own script banners are
outside the application's stdout contract.

Exit codes are 0 success, 1 operation/output failure, 2 usage/config failure,
124 deadline expiry and 130 cancellation. SDK error codes remain stable; the CLI
adds `USAGE` and `TIMEOUT`. Independent cleanup failure takes precedence over a
simple cancellation outcome. The first cancellation cause is retained even when
cleanup crosses the deadline.

SIGINT/SIGTERM cancel owned work. Read commands recheck cancellation after cleanup.
Storage requests already in progress drain before closure, so a deadline is a
cancellation request rather than a guaranteed wall-clock termination bound. A
mutation may commit before cancellation or output failure: inspect state before
retrying. Cancellation never promises rollback of an already completed mutation.

Output observes backpressure and cancellation. An unread output pipe is abandoned
on cancellation; cleanup finishes and diagnostics get up to one second to write.
Only then may the executable explicitly exit to release Node's pending native
stdio write. Output may be incomplete in this case and must not be accepted as a
complete JSON response. Broken pipes exit without an uncaught stack trace.

## Evidence and remaining scope

Seven CLI tests cover real process init/import/list/validate/rename/transaction/
export/delete, offline operation, exclusive output conflicts, config precedence,
argument/config bounds, missing-workspace preservation, broken pipes, a large
unread transaction result, and external/deadline cancellation during delayed
cleanup. Local tarballs of the initial CLI and its three internal dependencies were
installed offline into an isolated consumer; the installed executable initialized
and listed a fresh workspace. No packages were published.

This is recording-management composition, not completion of GOAL section 7.2.
Bundled sample loading, the initial local API, source planning/setup/capture/resume
and row lifecycle commands are implemented. Browser startup and full
diagnostics/guarded source cleanup remain to implement. Full packaged application acceptance also remains pending.

Three additional real-executable tests cover selected historical SQL, a join and
aggregate, exact JSON output, row-limit and statement rejection, unsupported
selections/options, terminal control-character escaping, command timeout and SIGINT.
The SIGINT fixture observes execute dispatch before interrupting; the timeout case
proves overall command expiry and may expire during initialization on a slow host.
These complement the adapter's execution-confirmed deadline test. No source
connection is needed for these offline recording workflows.

The current CLI and five internal dependency tarballs install offline with pinned
PGlite into an isolated consumer. Its installed `tts query` executes against a
locally seeded recording and returns exact large numeric text and selected-position
metadata. The current full gate passes 323 unit and 18 query/CLI tests.

Saved-check commands and `scan-check` are documented in `docs/invariant-scans.md`.
Scans return clear/violation on exit 0; incomplete work exits nonzero and includes
range/progress on stderr. Real-executable tests exercise stored SQL, first findings,
state budgets, plain/JSON diagnostics, timeout consistency and SIGINT after observed
SQL dispatch. Definition CRUD and v4→v5 migration are tested against real SQLite.
