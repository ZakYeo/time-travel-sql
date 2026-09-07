# Restoring a durable recorder head

`restoreRecordingHead(reader, reconstructor, recordingId, signal?)` returns canonical
recording metadata and an immutable SDK `HistoryState` suitable for a source stream.
It rejects unpublished or invalid recordings. It reads only durable local history;
no live source rows participate in reconstruction.

For a baseline-only recording, the helper reconstructs the baseline. Otherwise it
loads the final recorded transaction, reconstructs its predecessor and applies that
transaction through canonical replay. The resulting state retains the final commit's
fingerprint, so identical immediate redelivery remains idempotent. Checkpoint use and
authoritative validation remain the reconstruction adapter's responsibility.

The helper verifies the session's recording, selection and position, then uses the
shared `reconstructionRows` iterator for ordered paging, row/key validation and exact
declared size checks. Session metadata is pinned to its decoded value. It closes the
owned reconstruction session before returning and rechecks recording metadata after
replay. Concurrent changes cause rejection rather than returning a stale head.

Callers must hold exclusive recording ownership during restoration and subsequent
stream startup. The metadata recheck is an observation, not a lock or compare-and-swap
operation. The helper does not own or close the reader, reconstructor or capture lease.
Cancellation closes the opened session; failures never return a partial state, and
primary plus cleanup errors are retained together.

Rows are staged within the reconstruction session's declared replay limits before
creating the immutable state. These are logical row/key byte bounds, not total heap
limits: staged rows and the new state can coexist, and replaying the last transaction
can retain predecessor and successor state temporarily. Configure the reconstructor's
limits for the intended workload. Storage reads and reconstruction startup rely on
their adapters' cancellation/deadline contracts.

Unit tests cover baseline and checkpoint-backed heads, identical last-commit replay,
invalid coverage, metadata changes, incomplete rows, paging cancellation and aggregate
cleanup failure. Native PostgreSQL stop/reopen/resume now restores through this helper
while holding the capture lease, including a commit made while stopped. Automatic
reconnect, process-crash recovery policy and guarded slot cleanup remain pending.
