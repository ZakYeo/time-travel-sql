# Historical SQL engine evidence

This document records the original pinned-engine feasibility and SDK contract
evidence. The implemented library adapter and its current trust boundary are
in `historical-sql.md`. The five original tests remain in the required query-policy
gate alongside adapter integration tests. PGlite 0.5.8 reports PostgreSQL 18.3.

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

The original cursor fixture bounds only returned rows. The adapter now adds
input/output limits, exact type handling, unavailable-column grants and parent
execution deadlines. Intermediate materialization and total WASM/OS memory remain
outside a hard memory budget, and CLI composition is pending. The original
bootstrap authentication authority makes grammar and function restrictions
essential even after session authorization changes.

## SDK request and result contract

`decodeQueryRequest` validates bounded SQL text and configurable limits; SQL syntax
and permissions remain the engine's responsibility. `HistoricalQueryEngine` borrows
an immutable reconstruction view, owns disposable execution resources and must
drain them before settlement. Its deadline includes materialization and result
delivery. The library adapter now implements these requirements as described in `historical-sql.md`.

`QueryResult` retains ordered column names and PostgreSQL type OIDs with ordinal
arrays of text or SQL NULL. Duplicate names remain distinct. Expression types need
not be capture scalar types. Numbers, JSON and timestamps are never coerced into
JavaScript numbers, objects or dates by this contract. Adapter tests now cover all fourteen capture types, modifiers and a result array.

`QueryResultBuffer` validates unknown engine output and retains immutable copies.
Its output budget counts the entire compact JSON result, including column metadata,
row separators, UTF-8 and string escaping. It checks each bounded cell before
continuing, avoiding a whole-row allocation for over-budget wide results. Any row
failure poisons the buffer and discards accumulated rows; a partial result cannot
be returned as success. A finished buffer cannot accept more rows or finish again.
Outer transport envelopes and human formatting are not part of this byte budget.

| Limit                     |    Default |     Maximum |
| ------------------------- | ---------: | ----------: |
| Deadline                  | 30 seconds | 300 seconds |
| Result rows               |      1,000 |      10,000 |
| Result columns            |        128 |       1,024 |
| UTF-8 cell bytes          |      1 MiB |       1 MiB |
| Compact JSON result bytes |      8 MiB |      16 MiB |
| Materialized input rows   |    200,000 |   2,000,000 |
| Materialized input bytes  |    128 MiB |     512 MiB |

SQL text is capped at 64 KiB. The buffer enforces output limits only; a production
adapter must enforce input/deadline limits before and during its work. Five SDK
tests cover exact representations and ownership, exact JSON boundaries, malformed
results and all output limit types, request validation, and a logical 1 GiB row
rejected under a 64 KiB result budget. The engine policy fixture also routes its
exact numeric/JSON/timestamp result through this buffer.

## Unavailable-column permission evidence

A fixed lossy table contains one unavailable-cell placeholder and one known value
in the same column. The reader receives SELECT grants only for its available
columns. Queries over those columns and `COUNT(*)` succeed; direct references,
aggregates, predicates, sort keys, joins, whole-row references and CTE references
to the unavailable column fail with permission SQLSTATE 42501. Even `WHERE false`,
`LIMIT 0` and an unreachable CASE branch cannot hide the forbidden reference from
the engine's permission check. An entirely unused CTE containing such a reference
can be eliminated: `WITH q AS (SELECT secret FROM lossy) SELECT 1` succeeds with
`1`, without evaluating or returning that column. This is not a syntactic ban on
every mention of an unavailable column. Available answers remain unchanged after
rejection.

This supports a conservative materialization policy: if any selected row has an
unavailable value, deny that whole column for the query workspace. A query filtered
to a known row still fails when it references that column. Private placeholders
must never become query-visible SQL NULLs. Required identity columns remain
available, allowing row-count queries without exposing missing values. The test
establishes engine behavior; the adapter now derives grants from validated
reconstruction rows and provides safe query rejection diagnostics. It does not implement capture-time redaction or provenance.
