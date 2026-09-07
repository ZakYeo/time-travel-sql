# Automatic PostgreSQL reconnect

`resumePostgresRecording(store, reconstructor, connection, recordingId, options?)`
returns a supervisor immediately. Its `done` promise settles when capture stops or
fails; `status()` exposes starting, recording, waiting-to-retry, stopped or failed,
the number of retries and the latest safe failure code/message.

Each attempt uses the SDK's owned resume operation. It reserves a local generation,
acquires the source lease, activates writer fencing, restores the durable head,
checks saved identity and retained resources, and opens the stream. An attempt must
finish stream, local writer and source lease cleanup before another can start.
The supervisor never creates a replacement slot, publication, baseline or binding.

Only `SOURCE_UNAVAILABLE` triggers automatic retry. The default is five retries
across the supervisor's entire lifetime, with delays of 250, 500, 1000, 2000 and
4000 ms. Options can set `maxRetries` from 0–20 and initial/capped delays from
1–60000 ms, with the cap at least the initial delay. Successfully reopening does
not reset the budget. Exhaustion retains and reports the final source failure.

PostgreSQL SQLSTATE and Node transport error allowlists classify connectivity and
server availability. Authentication, protocol, capacity, schema, continuity,
corruption, local persistence and aggregate cleanup failures remain terminal.
The pinned pg driver also emits a few errors without codes for socket closure and
connection deadlines; a narrowly scoped compatibility list covers these, backed by
real socket-closure and blackholed-startup fixtures. Stable codes are preferred as
recommended by [PostgreSQL's error-code documentation](https://www.postgresql.org/docs/16/errcodes-appendix.html);
transport-code meanings follow [Node's error documentation](https://nodejs.org/api/errors.html).

`SOURCE_UNAVAILABLE` describes the failure, not whether arbitrary SQL is safe to
repeat. Setup and cleanup may have committed despite a lost response; their existing
explicit ownership inspection/recovery protocols still apply. Only retained capture
resume is automatically retried by this supervisor.

`stop()` drains an active recorder through the existing SDK session. During startup
or backoff it cancels owned work and returns the current durable recording info.
Without an active writer it does not rewrite recording status, which may remain
interrupted. External signal cancellation rejects completion; a concurrent stop does
not turn it into success. Stopping also preserves already queued independent source
failures and cleanup errors. Store and reconstructor remain caller-owned.

Source terminal status now includes the retained `HistoryError`, so a disconnect
while the recorder awaits startup metadata retains its actual cause. Lease loss
also survives cancellation of head restoration. This avoids retry decisions based
on guessed messages or mismatched-state errors at application boundaries.

Native tests cover stream-backend termination, lease-backend termination, socket
closure, an injected acknowledgement write failure around actual capture, a real
startup timeout, and a dropped slot during backoff. Recovered rows match source SQL;
the dropped-slot case ends without replacement and retains the last durable range.
Unit tests cover retry budgets/delays, terminal failures, cleanup precedence, stop
and cancellation races, and terminal failure during recorder startup.
