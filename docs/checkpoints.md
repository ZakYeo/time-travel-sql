# Checkpoints and committed selection

Selection uses source positions, never wall-clock order. `baseline` selects the
published initial state. `before` a recorded transaction selects its predecessor;
`after` includes that whole transaction. Missing transactions and positions outside
coverage are errors. The SDK exports `decodeSelection` and `selectedPosition` as
the canonical policy. Timestamp resolution is still pending.

The local store implements the SDK's separate `HistoryCheckpoints` port:

```ts
import { decodeSelection } from '@time-travel-sql/sdk';

const checkpoint = await store.publishCheckpoint(
  recordingId,
  decodeSelection({ kind: 'after', position: '123' }),
);
const firstPage = await store.checkpointRows(recordingId, checkpoint.position, {
  cursor: null,
  limit: 100,
});
```

`checkpoints` lists metadata in committed-position order. `checkpointRows` uses
opaque row-key cursors; continue until `nextCursor` is null. `removeCheckpoint`
removes only the derived artifact. Removing a recording cascades to its checkpoints.

## Publication and verification

Publication always reconstructs the selected state from the authoritative baseline
and transactions. It inserts all checkpoint rows and their final manifest in one
SQLite transaction. Rebuilding an existing position atomically replaces that
checkpoint. Failure, including SQLite page exhaustion, rolls the whole operation
back and leaves capture progress unchanged.

Each manifest identifies the recording, source, epoch, schema and committed
position, with transaction/row counts and two SHA-256 checksums. The row checksum
uses the same ordered `[rowKey, rowDigest]` framing as baseline publication.
The history checksum covers UTF-8 canonical JSON records, each followed by one
newline: `[recordingSchema, baselinePosition]`, all baseline rows in UTF-8 row-key
order, then all transactions through the checkpoint in source-position order.
This binds the derived state to its authoritative prefix. These are corruption
checks, not authenticity guarantees against a deliberate rewrite of all metadata.

Public checkpoint pages verify the complete artifact and its authoritative prefix
before exposing rows. A single verification cache is keyed by recording/checkpoint
metadata and SQLite `data_version`, so subsequent pages use indexed reads until
the underlying data changes. A valid row transplanted from another checkpoint is
rejected even when its individual checksum and the total row count still match.

On an uncached head reconstruction, the store tries checkpoints from newest to
oldest. Invalid derived artifacts are skipped. The authoritative prefix is still
validated; its corruption is an error, never hidden by a checkpoint. A verified
checkpoint supplies the initial state, and only its transaction suffix is applied.
If no checkpoint is valid, reconstruction starts from the baseline. Exceeding the
candidate/work budget fails explicitly instead of silently skipping older artifacts.

The database is now version 2. An intact version-1 database migrates transactionally
by adding checkpoint tables, without changing recording contents. Damaged schemas
and unsupported future versions remain errors.

## Resource bounds and current limits

`HistoryState` accounts for retained canonical row and identity-key UTF-8 bytes.
Defaults are 100000 rows and 64 MiB. `ReplayLimits` can select 1–1000000 rows and
1–256 MiB; local storage accepts them through `replayLimits`. The state exposes
`rowCount` and `retainedBytes`. Baseline construction and each transaction event
check these limits before publishing the new immutable state. A transaction's
intermediate working state must fit, even if later events would shrink it.

These logical counts exclude JavaScript object/map overhead, retained predecessor
states and SQLite memory. The owned worker's separate heap/deadline safeguards
remain active; no total-process memory guarantee is claimed from byte accounting.

Checkpoint attempts and baseline fallback share one verification budget: 1000
candidates, one million examined rows, 100000 transactions, one million events,
and 512 MiB of stored JSON payload bytes. Raw payload bytes are charged before
checksum/JSON decoding, including failed candidates and rows. The operation also
has the existing 30-second worker deadline. Limits reject work, never return a
truncated historical state. Larger-history tuning and measured resource envelopes
remain required before release.

Prefix verification still reads historical records. Checkpoints reduce state
materialization and transaction application; they do not currently make verification
I/O independent of history length. Publication must fit baseline replay, whereas
restoring a valid checkpoint can fit a smaller state budget after rows were deleted.
Automatic checkpoint scheduling, public reconstruction sessions, query integration,
streaming exchange and performance measurements remain pending.

Tests compare six checkpoint states and every suffix against an independent model
over 90 commits. Actual SQLite regressions cover selection, restart with an older
valid checkpoint, same-count corruption, authoritative corruption, more than 100
bad candidates, explicit budget exhaustion, page-full rollback and version-1 migration.
