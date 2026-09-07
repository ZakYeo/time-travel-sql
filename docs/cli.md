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

| Command                   | Behavior                                                        |
| ------------------------- | --------------------------------------------------------------- |
| `init`                    | Create/open the workspace and versioned `history.sqlite` store. |
| `list`                    | Return one bounded page with an opaque `nextCursor`.            |
| `inspect ID`              | Return canonical metadata and recorded coverage.                |
| `validate ID`             | Replay all authoritative history using the pinned exporter.     |
| `rename ID NAME`          | Change a local recording name.                                  |
| `remove ID`               | Delete the local recording, leaving source resources untouched. |
| `export ID FILE`          | Publish a completed portable file exclusively.                  |
| `import FILE`             | Validate and atomically publish a portable recording.           |
| `transaction ID POSITION` | Return a complete commit at an exact decimal position.          |

Only `init` creates a missing workspace. Other commands require an existing regular
database file; ordinary store commands may apply supported schema migrations.
`validate` and `export` use the read-only exporter. Local concurrency, migration
and limits follow the storage contract. Deletion is explicit and does not require
an interactive prompt, so automation must choose its workspace and ID deliberately.

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
cleanup. Local tarballs of the CLI and its three internal dependencies were
installed offline into an isolated consumer; the installed executable initialized
and listed a fresh workspace. No packages were published.

This is recording-management composition, not completion of GOAL section 7.2.
Application/sample startup, source doctor/setup/capture/resume, row/diff inspection,
historical SQL, invariant scanning and full diagnostics/owned cleanup commands
remain to implement. Full packaged application acceptance also remains pending.
