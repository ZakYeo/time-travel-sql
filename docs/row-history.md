# Recorded row lifecycles

`inspectRowHistory(history, request, control)` follows a row through the recorded
coverage using a borrowed immutable `RecordingExport`. It never queries a live
source. Open the export with `control.signal` so cancellation can interrupt pending
port reads; the SDK checks that signal between work and calls the host-provided
`cooperate` scheduler. The caller owns and closes the export/provider.

The request specifies `tableId`, an opaque canonical `key` from row inspection,
and an explicit `selection` (`baseline`, `before` or `after` a committed position).
The row must exist at that selected state. To follow a deleted row, anchor it before
its deletion. Missing rows or boundaries fail explicitly. Keys are bounded to
64 KiB, matching the canonical row-key contract.

The first bounded replay identifies the row's origin at the anchor. The second
replays the full pinned coverage and follows that origin. Updates preserve identity,
including several key changes inside one transaction. Delete terminates the
lifecycle; an insert reusing the key is a separate origin, even inside the same
transaction. Insertions into keys vacated by an update are likewise separate.
No relationship is inferred from matching values or similar keys.

The result contains the recording metadata, table, resolved anchor, full pinned
`range`, `origin`, final `status` (`present` or `deleted`), `currentKey`, applied
options, work counters, and a contiguous page of entries. Each entry includes:

- `kind`: baseline, insert, update or delete.
- Committed `position`, transaction ID and zero-based event index (null for baseline).
- Recorded commit microseconds, or null when unavailable.
- Before/after keys and exact rows, using null for an absent side.

A baseline entry is an observation at the start of coverage, not a claim about when
that row was created. Entries preserve event order and intermediate key moves;
these are per-event changes, distinct from a transaction's net effect. Tagged row
values retain decimal precision, redaction/exclusion, SQL NULL, binary and temporal
representations. An unchanged field remains present in both recorded images; absent
row sides are not SQL NULL cell values.

Default options are offset 0, limit 100, 8 MiB result items, 256 MiB aggregate input,
10000 replayed transactions and 100000 events. Maxima are offset 2000000, limit
1000, 16 MiB results, 1 GiB input, 100000 transactions and 1000000 events. Input
budgets aggregate both passes, including baseline replay and origin-map changes.
Canonical replay independently caps each state at 100000 rows / 64 MiB. These are
logical work/retention bounds, not a hard process RSS guarantee.

`total` counts every lifecycle entry. `nextOffset` identifies the next page or is
null when complete. Pagination never stops validation: bad history after a full
page still rejects the request. Oversized first entries, work exhaustion and
cancellation fail without returning a partial success. Full-head replay also
checks declared transaction counts and rejects trailing transactions beyond the
recorded head. The immutable snapshot fixes both passes; a live append or local
recording deletion does not change an already opened history session.

## CLI

```sh
tts rows recording-id orders before:30 --workspace ./history --json
tts row-history recording-id orders before:30 "$ROW_KEY" --workspace ./history --limit 20 --json
tts row-history recording-id orders before:30 "$ROW_KEY" --workspace ./history --offset 20 --json
```

Set `ROW_KEY` to the exact key returned by row inspection and quote it as one shell
argument. CLI pages default to 50 entries and cap at 100. The ordinary command
deadline, cancellation, stdout/stderr and exit-code contracts apply. Each CLI call
opens its own pinned snapshot; the returned range states which head it examined.
Append activity can extend coverage between calls. SDK/server callers can retain
one export session across pages when they require the same snapshot.

Tests cover key changes, vacated-key reuse, delete/reinsert separation, exact values,
nonzero baseline/head anchors, source deletion during a pinned investigation,
post-page corruption, budgets and cancellation. Actual CLI tests export a recording,
remove the original, import into a fresh workspace, and reproduce its lifecycle
and offset pages offline. Browser row navigation/presentation remains pending.
