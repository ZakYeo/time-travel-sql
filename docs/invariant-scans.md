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
is pinned. Saved SQL check persistence and CLI/browser composition remain pending.
