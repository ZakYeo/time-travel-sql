# Historical reconstruction

The SDK exposes `HistoryReconstructor` and `ReconstructionSession` ports and the
portable `reconstructionRows` async iterator. The local storage adapter implements
these through `createLocalReconstructor`, separately from the recording writer.

```ts
import { reconstructionRows } from '@time-travel-sql/sdk';
import { createLocalReconstructor } from '@time-travel-sql/storage-local';

const reader = createLocalReconstructor({
  path: '/absolute/private/directory/history.sqlite',
});
try {
  const session = await reader.open({
    recordingId: 'recording',
    selection: { kind: 'baseline' },
  });
  try {
    for await (const row of reconstructionRows(session)) {
      // Stage rows in the consumer; publish only after successful completion.
      void row;
    }
  } finally {
    await session.close();
  }
} finally {
  await reader.close();
}
```

Selections support baseline, before a recorded transaction and after a recorded
transaction. Resolution validates coverage and uses committed positions. Timestamp
selection and historical SQL workspaces remain pending.

Each open owns a worker and a read-only SQLite transaction. It verifies recorded
history, restores a verified checkpoint when useful and replays to the requested
position. The database closes before the session becomes available. The worker
retains immutable selected rows, so later appends, deletion or recreation of the
recording cannot change its pages. An idle session does not pin the SQLite WAL.
Opening never creates or migrates a database; use the store to migrate first.
Exclusive database locks fail promptly with `STORAGE_FAILURE`; callers can retry.

Pages contain at most 100 rows and fit the 20 MiB transport bound. Within each
table, rows follow strictly ascending canonical `rowKey` string order (UTF-16 code
units). Cursors belong to the session and table; null starts iteration and a null
next cursor completes it. The SDK iterator visits schema tables in order, checks
page progress, row ordering and total row/byte counts, and leaves session ownership
with its caller. Consumers must stage streamed output until iteration completes.

An optional structural `AbortSignal` passed to `open` controls the entire session
lifetime. Abort, session close and owner close terminate outstanding read work;
owner close also cancels pending opens. Close is idempotent. Reconstruction does
not cancel recording writes. Capacity includes pending opens: default two workers,
configurable from one to four; excess opens reject with `LIMIT_EXCEEDED`.

Replay defaults to 100,000 rows and 64 MiB of canonical row/key bytes, configurable
within SDK limits. Checkpoint verification shares the work budgets documented in
`checkpoints.md`. Each worker has a 256 MiB V8 old-generation heap limit and each
operation a 30-second deadline. These are not total process-memory guarantees;
measured resource envelopes remain pending.

Tests cover exact selection, immutable sessions across deletion/recreation, WAL
release, cancellation and ownership, exclusive locks, checkpoint restoration under
a smaller state budget, missing files, multi-table iteration, invalid providers and
state larger than one transport response. A fresh independent review verified the
lock-wait fix, paging contract and iterator ownership.
