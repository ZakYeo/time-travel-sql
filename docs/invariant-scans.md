# Chronological invariant scans

The SDK `scanInvariant` service evaluates a bounded SQL query against the starting
state and each subsequent committed state in an inclusive selected range. Returned
rows represent violations. It stops at the first observed violation, even when the
predicate later recovers. It never uses binary search or source connections.

The caller owns a pinned `RecordingExport` and `HistoricalQueryEngine`. Both range
endpoints resolve before any query executes. Baseline rows and transactions are
decoded and replayed through canonical `HistoryState`; each SQL query receives a
borrowed immutable reconstruction view. The caller must open history with the same
cancellation signal and close both resources after settlement, including errors.

A violation reports its position, predecessor, exact query results, canonical
transaction events and a net row/field diff from the predecessor. Reverted changes
remain in the events but disappear from the net diff. The existing canonical
comparison service validates both states and reports full counts plus up to 1,000
diff rows within an 8-MiB page; `total` and `nextOffset` expose incomplete diff
output. Baseline failure has no predecessor, transaction or diff.
`startingState` distinguishes failure already present at the selected
start; a predecessor outside the range has not been evaluated. Findings are first
observed violations, not proof of the underlying business cause.

Results include the pinned recording coverage, resolved range, configured scan and
query limits, and progress. `clear` means every state in that range was evaluated
without violations. `incomplete` reports cancellation, timeout or exhausted limits;
its last evaluated position never advances for a failed query. Invalid ranges,
corrupt history, denied SQL and unexpected engine failures reject explicitly.
Cancellation during initial endpoint resolution rejects before a resolved-range
report is available. Progress callbacks receive frozen counters during replay and
after successful evaluations; callbacks must be quick and must not throw.

Default scan budgets are five minutes, 1,000 evaluated states, 10,000 replayed
transactions, 100,000 events and 256 MiB of aggregate input bytes. Baseline loading,
prefix replay before the selected start, transaction JSON, each evaluated
state's retained row/key bytes and both diff inputs count as work. Replay uses the canonical default
100,000-row/64-MiB state limits. A transaction is decoded/applied atomically within
the existing 10,000-event/16-MiB transaction limits. The host supplies a monotonic
clock and cooperative yields; query deadlines shrink to the remaining scan budget.
The host must also enforce its deadline while opening the history session and
during pending storage reads. The scanner's clock checks alone cannot interrupt a
pending promise. Logical byte bounds do not claim hard total-process memory limits.

Query result limits are enforced without truncated successful SQL results. A finding
also contains one separately bounded canonical transaction and diff page; the query byte budget
does not include either of those or recording metadata. `diffLimits` reports the
separate comparison budgets. A per-query resource limit
is reported as incomplete/limit unless the overall scan deadline has also expired.

Real SQLite tests cover fail–recover–fail order, initial failures, clear ranges,
prefix and evaluation budgets, cancellation and timeout progress. A real PGlite
test executes the SQL after deleting the live recording while its read snapshot
is pinned. Browser composition remains pending.

## Saved definitions and CLI

`tts save-check ID CHECK NAME SQL` atomically creates or replaces a local,
recording-scoped definition. Saving validates names, SQL byte bounds and query
limits; it does not execute SQL or assert that the engine will accept it.
`show-check`, `list-checks` and `remove-check` inspect, page and delete definitions.
Definitions are limited to 1,000 per recording, 256-byte names and 64-KiB SQL,
with canonical query limits. Replacing an existing definition remains possible at
capacity. Concurrent writers serialize through SQLite transactions; the last
committed explicit save wins. Schema v5 adds an indexed, integrity-checked table
with cascading recording deletion. Version 4 migrates without altering history.
The supported configured database minimum is now 128 KiB to accommodate schema
overhead; the default remains 512 MiB, excluding WAL and temporary files.
Saved checks are local annotations and are not included in portable recordings.

`tts scan-check ID CHECK FROM TO` opens one read snapshot containing both the
saved definition and history, then invokes the shared scanner. Concurrent check
replacement, recording deletion or capture cannot change that invocation. The
CLI owns the provider, history session and disposable engine through cleanup.
Its overall `--timeout-ms` budget covers configuration, opening/validation, check
loading, queries, diff and output. The stored per-query timeout also applies
(30 seconds for a check saved through the CLI). `--limit` overrides SQL result
rows for that invocation; `--max-states` bounds evaluated states. Scan input,
replay, event and diff limits above remain effective and appear in the report.

Exit 0 means the scan returned a clear range or a first-observed violation;
automation must inspect `outcome.kind`. Incomplete work exits 1 for resource/work
limits, 124 for timeout and 130 for external cancellation. It writes its report
to stderr in both plain and versioned JSON modes, with no successful stdout.
The nested outcome reason agrees with the CLI timeout/cancellation diagnostic.
Cancellation while preparing history/check/range reports requested selections,
`phase: preparing` and zero evaluations, without invented resolved positions.
Errors before scan composition, such as configuration failures, use the ordinary
CLI diagnostic. Failed SQL and integrity checks remain explicit operation errors.
