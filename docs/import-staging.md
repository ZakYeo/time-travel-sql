# Atomic recording import staging

The public SDK `HistoryImports.beginImport(metadata, signal)` contract creates an
owned `RecordingImport` session. The local store implements it with a separate
private SQLite file. Staging does not create a destination recording, and the
normal reader, listing and reconstruction APIs cannot see it.

Stage baseline batches of at most 100 rows, call `publishBaseline(position)` when
that baseline is complete, then append whole committed transactions in order.
Canonical storage validation enforces row types, keys, duplicate rejection, exact
predecessors, before-images and atomic replay. Unlike live delivery, a duplicate
transaction in an imported stream is rejected rather than treated as redelivery.

Call `publish(expectedInfo)` only after the framing checksum and the full semantic
manifest have been verified by the import service. The expected information must
match all staged metadata, baseline checksum/count and committed coverage, with a
closed lifecycle (`stopped`, `interrupted` or published `invalid`). Active recording
and unpublished baseline states cannot be imported as published history.

Publication holds a stable read transaction on staging and one destination write
transaction. It rereads authoritative baseline/transaction data, verifies storage
checksums, and copies through the canonical Writer, which replays the complete
history again. A late failure rolls back the entire destination insertion. An
existing ID is rejected; it is never replaced. The session is sealed only after
the destination transaction and response validation succeed.

Only authoritative metadata, baseline and transactions are copied. Checkpoints
remain rebuildable; source resource bindings and local writer ownership are not
transferred. Importing data grants no authority to reconnect to or delete source
resources. Once published, the history supports ordinary offline reconstruction.

## Resource ownership and cancellation

Each store worker permits one active import session. Staging uses a fresh
`.tts-import-*` directory beside the destination, with restrictive local directory
and database permissions. The parent registers its exact path before acquisition,
so store closure can remove it after a worker timeout/error/termination. No global
scan or deletion of another process's staging paths is performed. Terminating the
entire parent process can leave its private directory behind; automatic crash
scavenging of abandoned import directories remains unfinished.

Private staging writes and disposal do not acquire the destination write lock.
Only final publication does. The staging database uses the configured storage and
replay limits; authoritative work is additionally limited to 512 MiB, 1,000,000
baseline rows, 100,000 transactions and 1,000,000 events. Failed attempts consume
work budget too. SQLite WAL and temporary files require space beyond the main
file limit, and staging temporarily duplicates recorded data on disk.

Abort listeners exist only while each operation is pending, with independent
listeners for overlapping calls. A shared cancellation flag reaches synchronous
worker work: row copying, canonical baseline reconstruction, commitment scans and
transaction boundaries. Each individual bounded transaction remains synchronous.
Native SQLite lock waits remain bounded by the storage timeout. Cancellation is
checked before the publication commit decision; cancellation after commit begins
cannot revoke a committed recording. Lost commit responses require inspecting the
destination ID rather than assuming publication failed.

Always close the session. `close()` drains its accepted staging requests and
removes staging only, never a published recording. Store closure terminates the
worker before attempting every registered directory cleanup. Cleanup failures
remain observable alongside the triggering error.

## Evidence and remaining work

Actual SQLite worker tests cover invisible staging, offline reconstruction,
existing-ID preservation, rollback after corrupted staged replay, declaration and
duplicate rejection, destination lock independence, overlapping cancellation
listeners, abort during an in-flight publication and cleanup after real worker
termination. Exact scan-step tests cover both baseline reconstruction and checksum
cancellation. Injected destination COMMIT failure proves staging remains retryable;
worker-close failure injection proves directory cleanup still runs.

The semantic stream service in `docs/portable-recordings.md` now drives this
primitive after complete framing and domain validation. Context/policy provenance,
CLI file workflows and the remaining full-goal requirements are still pending.
