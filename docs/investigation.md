# Historical row inspection and state comparison

The SDK exposes `inspectReconstructedRows(view, options, control)` and
`compareReconstructedStates(pair, options, control)`. They consume public
reconstruction views and return canonical recorded values with authoritative
selected positions. They never query a live source. Callers retain ownership of
views/pairs and close them after success, failure or cancellation.

## Snapshot and ownership

`createLocalStatePairs({ path, replayLimits?, maxConcurrent? })` opens a pair via
`open(fromRequest, toRequest, signal?)`. Both requests must name the same recording.
One worker restores both states in one SQLite read transaction, then releases the
database snapshot before serving immutable rows. Concurrent local append, rename,
deletion or recreation cannot mix recording versions within a pair. Each pair
occupies one worker slot; provider and pair closure release both views together.
Startup cancellation terminates the owned worker.

Single-state reconstruction uses the same implementation with one view. Replay
limits apply separately to each state; a pair can retain twice those canonical
row/byte limits. These are logical data budgets, not exact heap measurements. The
worker retains its existing memory ceiling. Investigation adds an aggregate input
budget below.

`ReconstructionView` is borrowed and contains only `info` and `rows`.
`ReconstructionSession` and `ReconstructionPair` own lifetimes. Custom pair
providers must implement the same single-snapshot guarantee; matching metadata
alone is not a concurrency lock. The SDK rejects different recording metadata
across the two views.

## Comparison semantics

Rows merge in schema table order and ascending row-key UTF-16 order within each
table, matching reconstruction. This differs from portable stream UTF-8 ordering.
Reversing selections reverses insertions/deletions and before/after fields;
chronological ordering is not required.

A result includes both `ReconstructionInfo` objects, inserted/deleted/updated/
unchanged counts, a bounded `items` page, the complete matching difference `total`,
`nextOffset` and `unavailableValues`. Each item contains its table, canonical key,
kind, full before/after rows and changed fields for updates. A null before/after
row denotes absence; SQL NULL remains a tagged value within a present row.

Equality compares canonical recorded representations. Numeric formatting and
unavailable markers remain visible. `unavailableValues` indicates redacted/excluded
values in the selected table data: equal observed markers do not establish equality
of underlying unavailable data. Counts and this flag cover all matching rows,
including those outside the returned page.

These are net differences between committed states, not a transaction event log.
Insert/delete pairs leaving no retained row have no net difference. Primary-key
changes appear as deletion plus insertion; no row lineage is inferred.

## Filtering, paging and bounds

Options are validated plain data with these defaults and maxima:

| Option           | Default             | Maximum                   |
| ---------------- | ------------------- | ------------------------- |
| `tableId`        | all recorded tables | one known stable table ID |
| `offset`         | 0                   | 2,000,000                 |
| `limit`          | 100                 | 1,000                     |
| `maxResultBytes` | 8 MiB               | 16 MiB                    |
| `maxInputRows`   | 200,000             | 2,000,000                 |
| `maxInputBytes`  | 128 MiB             | 512 MiB                   |

Input budgets sum declared canonical rows/retained bytes across both views (one
for inspection), before scanning. Every row is decoded and checked against schema,
key ordering and declared completeness. Filtering or filling the output page never
skips final validation, including other tables. Later malformed data rejects the
entire result.

The output byte budget covers the compact JSON item array; metadata/envelope bytes
and human indentation are additional. When the next item cannot fit, the page
ends contiguously and reports the next offset, while counting and validating the
remaining input. An oversized first matching item fails explicitly. Values are
never silently truncated. An offset beyond the total returns an empty terminal page.

Inspection uses the same rules, returning `{tableId, key, row}` entries, one
authoritative `info`, and the full matching row count. Fetch another page using
`nextOffset` with the same selected states and filter. Calls recompute bounded
input; no expired worker cursor is exposed.

`control` requires a cancellation signal and an async `cooperate` callback that
yields to the host event loop. Cancellation is checked between rows; the callback
runs after 256 rows or 16 Ki characters of work. The CLI supplies `setImmediate`;
browser consumers can supply their scheduler. Pending adapter I/O must observe
the same signal. Pure SDK imports install no ambient scheduler.

## CLI and evidence

```sh
npm run tts -- rows recording-id orders before:10 --workspace ./history --json
npm run tts -- compare recording-id orders baseline after:20 --workspace ./history --limit 20 --json
```

Selections are exactly `baseline`, `before:POSITION` or `after:POSITION`, with
canonical decimal positions. Missing boundaries fail; no nearest/current-state
fallback occurs. Use `--offset` for subsequent pages; `--cursor` remains exclusive
to recording lists. CLI page size defaults to 50 and is capped at 100.

Eleven tests cover exact fields, unavailable values, reversed comparisons,
Unicode ordering, full validation after truncation/filtering, input/output budgets,
timer cancellation, legal deltas above 4 MiB, paired-worker lifetimes and offline
CLI selections. An actual SQLite fixture deletes the recording between restores
and proves the second view remains in the original snapshot. The full native
PostgreSQL suite also passes after the shared worker protocol change.

Recorded [row lifecycles](row-history.md), historical SQL and headless invariant
scans are implemented. Context presentation, browser journeys and remaining
full-goal acceptance requirements remain pending.
