# Local recording storage

`@time-travel-sql/storage-local` implements the SDK's separate history writer,
reader and recording-management ports. Its only production package dependency is
the SDK. Node's built-in SQLite runs in an owned worker, outside the calling
thread. Call `close()` to drain accepted work and release that worker.

```ts
import { openLocalStore } from '@time-travel-sql/storage-local';

const store = await openLocalStore({
  path: '/absolute/private/directory/history.sqlite',
  maxBytes: 512 * 1024 * 1024,
});
try {
  const recordings = await store.list({ cursor: null, limit: 25 });
  // Pass recordings to your application; the adapter owns no UI or source.
} finally {
  await store.close();
}
```

## Publication and commit contract

Creation persists validated schema/source/epoch metadata with a `bootstrapping`
status. Baseline batches contain at most 100 rows and commit atomically. Duplicate
keys reject the entire batch. Staged rows survive restart but cannot be read as
published history. Only `publishBaseline` exposes them after complete validation.
Publication records the exact source position, row count and aggregate checksum.

`append` validates a complete canonical transaction against recorded state. All
events, the head position and transaction count commit in one SQLite transaction.
Identical historical redelivery returns `duplicate`; divergent redelivery fails.
An invalid later event or SQLite write failure leaves durable progress unchanged.
Sources must acknowledge only after `append` resolves successfully. A worker
failure can leave the caller uncertain whether a commit completed: reopen, inspect
durable progress and redeliver the same transaction. Never infer failure to commit
solely from a rejected or lost response.

Stop/interruption retains data and permits explicit resume. Invalid coverage
cannot be resumed. `remove` deletes the whole recording, baseline and transactions
in one transaction; it never removes a required history prefix.

## Concurrency and integrity

SQLite uses WAL, full synchronous durability, foreign keys and strict tables.
Writes acquire `BEGIN IMMEDIATE` with a five-second busy timeout. Readers use a
deferred transaction and see a consistent committed snapshot, including while
another connection holds the writer lock. Multiple processes can open the same
file; conflicting writes serialize and revalidate the current predecessor. Use
the same configured size limit for every opener.

Recording metadata, baseline rows and transactions carry SHA-256 checksums of
their canonical JSON. Baseline publication additionally commits to every ordered
row: SHA-256 over UTF-8 `JSON.stringify([rowKey, rowDigest]) + '\n'` records, in
UTF-8 byte key order. Full baseline reconstruction checks this aggregate and
the published count. Paginated baseline reads check the total count and each
returned row; they do not rescan every row's content on each page. Checksums detect
corruption; they do not establish authenticity against deliberate rewriting.
The count check scans the matching baseline index on each page; its cost grows
with the full baseline. Removing that repeated work without weakening integrity
is part of the remaining bounded-work/performance implementation.

Positions use indexed 40-digit decimal sort keys. Reads validate index identities
against decoded contents. A single cached head avoids replaying the entire history
on every append. Its metadata must match and SQLite `data_version` must remain
unchanged; external commits force authoritative reconstruction. A failed write
cannot make an uncommitted cached head match durable progress.

The initial migration accepts an empty version-0 database. Intact version-1
databases gain checkpoint tables and version-2 databases gain immutable capture
bindings; version-3 databases gain durable writer ownership. The current version is 4. Read-only reconstruction supports intact
versions 2, 3 and 4 without migration. Each supported version
must match its known schema; missing tables, extra application objects and future
versions are rejected. Reopening never recreates missing authoritative tables.
Existing databases are not migrated down or treated as fresh recordings.

## Current bounds and remaining work

- New database files use mode `0600`; newly created directories use `0700`.
  Existing parent-directory permissions are not changed.
- `maxBytes` defaults to 512 MiB, with a minimum of 128 KiB. It limits SQLite main
  database pages for that connection. WAL, temporary files and filesystem overhead
  need additional space. Deletion frees reusable pages; it does not shrink the file.
- Pages contain at most 100 items and have a 20 MiB transport ceiling. The worker
  queue permits at most 128 pending operations and 40 MiB of encoded requests.
  Oversized submissions reject before being posted to the worker.
- Worker operations have a 30-second deadline, including queue time. Exceeding it
  terminates the worker and rejects outstanding work. Its V8 old-generation heap
  limit is 256 MiB; this is not a bound on total process or SQLite memory.
- Baseline publication materializes a complete state under explicit row/key byte
  and row-count budgets. Uncached restart uses a verified checkpoint when available
  and applies its suffix. Verification still scans the authoritative prefix under
  a shared work budget. See `docs/checkpoints.md`; measured large-history resource
  envelopes remain pending. Public reconstruction sessions are documented in
  `docs/reconstruction.md`.
- Portable streaming import/export, source acknowledgements and crash-window
  integration, capture configuration/context metadata, and application composition
  are subsequent slices. The private SQLite schema is not the exchange format.

Actual SQLite tests cover restart, old duplicates, atomic staging and event failure,
concurrent handles, WAL reads during a writer lock, storage exhaustion, corruption,
missing baseline rows/tables, future/foreign databases, deletion and close draining.

## Durable writer ownership

`prepareRecording(id)` reserves an ordered generation before source acquisition;
its `activate()` returns a writer lease after acquisition. Append and lifecycle
updates require the active generation and recording incarnation. Once a recording
uses fenced ownership, ordinary unfenced writes reject, including after release.
Lease close waits for request capacity and does not release a replacement owner.
Explicit local deletion atomically removes ownership with history, so crashed or
invalid recordings remain deletable and stale handles cannot write after recreation.
The SDK resume operation owns this protocol; direct recorder callers own their leases.
