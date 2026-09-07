# Owned recording sessions

`startRecording(stream, store, recordingId)` validates the canonical recording
schema and durable position against stored metadata, then returns a
`RecordingSession`. The supplied stream must already be open at the persisted head.
Both idle and commit-buffered active streams are accepted. Bootstrapping, invalid,
mismatched and terminal sources are rejected before lifecycle changes. Starting
from stopped or interrupted status transitions back to recording.

The session owns stream closure. The caller must exclusively own capture for this
recording and retains ownership of storage and any source lease. PostgreSQL callers
can compose a capture lease, bound bootstrap, stream and session through public APIs.
This primitive does not acquire locks, reconstruct a head or reconnect by itself.
Use `restoreRecordingHead` under exclusive ownership to obtain its initial state
through public reconstruction APIs; see `docs/restoring-recording-head.md`.

The loop validates each transaction, awaits durable append and only then acknowledges
it. `session.stop()` cancels a pending read, drains an already accepted append and
avoids acknowledging after closure. Successful stop persists stopped status and
retains source resources. `session.done` and repeated stop calls expose the same
completion promise. A stalled storage operation still depends on the storage
adapter's deadline; the SDK does not discard an accepted write to make stop faster.

Only cancellation after owned close begins on an active source can complete as an
ordinary stop. Already rejected operations and terminal source states preserve
independent failures. Source implementations must update terminal status before
rejecting pending operations. Append failure is never suppressed by stop.

Validation failures with an `INVALID_*` code end coverage as invalid. Other capture,
persistence or cleanup failures mark the recording interrupted and reject completion.
Previously durable rows and commits remain available. An acknowledgement failure
therefore retains the just-persisted commit for replay-safe recovery. If lifecycle
persistence itself fails, the previous status remains; all errors are retained in
the completion error. Status alone cannot establish that a crashed recorder is alive.

Unit tests cover pending-read stop, append draining, acknowledgement failure,
append cancellation, invalid events, startup mismatch, buffered startup, cancellation
precedence and aggregate cleanup failures. Native coverage runs bound bootstrap,
continuous capture, stop, store reopen and public head restoration/lease
reacquisition. A write made while stopped is buffered before the resumed session
starts and recorded once. Automatic recovery, process-crash barriers, checkpoint
scheduling and guarded slot deletion remain pending.
