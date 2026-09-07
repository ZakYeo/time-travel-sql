# PostgreSQL live stream

`openPostgresStream` starts from a verified immutable `HistoryState` and an existing
slot/publication. It runs read-only preflight and checks cluster identity/timeline
again on the actual replication connection before starting pgoutput. The adapter
implements the runtime-independent SDK `SourceStream` port.

One reader receives one complete canonical transaction. Another read requires
durable acknowledgement of that transaction first. `recordNextCommit` validates
the transaction, awaits the storage append and then acknowledges its position.
Any failure closes the stream; append and cleanup errors are preserved together.
Successful calls leave the stream open for its owner. Storage append must atomically
persist events and progress, as the SQLite adapter does.

Automatic and timer acknowledgements in the driver are disabled. Requested
heartbeats acknowledge only the confirmed durable head. The adapter adjusts for
the pinned driver's exclusive-end convention. Observed server WAL and received
unconfirmed commits cannot advance acknowledged progress.

The stream holds one application transaction until acknowledgement. Transaction
wire/event limits and canonical replay limits apply. The driver's socket buffers
and internal flow-control queue are separate; this is not a measured total-memory
bound. A configurable deadline of 1–30000 milliseconds (default 30000) bounds
replication startup after preflight and waiting for durable acknowledgement.
It does not bound idle streaming or the duration of a partial transaction.

Cancellation, deadline expiry and transport/validation failure release pending
reads and close the owned connection. Closing discards unconfirmed work and retains
the last durable position. The slot/publication remain for explicit resume or
cleanup. Startup cancellation settles independently of the driver's potentially
pending connect promise, while awaiting socket cleanup.

Native tests exercise SQLite append/reopen, ordered delivery, unconfirmed redelivery
after manual reconnect, cancellation of an idle read, stalled actual-stream
authentication and acknowledgement timeout without slot advancement. A requested
heartbeat after newer unrelated WAL confirms that only durable progress is sent.
SDK tests prove append-before-ack ordering and preservation of cleanup failures.

This is a live transport primitive. Bootstrap orchestration, resource ownership
markers, automatic reconnect, persisted lifecycle/coverage transitions, all crash
windows, catalog-only DDL monitoring, context/truncate policy and measured resource
envelopes remain pending. Preflight uses separate connections and cannot establish
exclusive ownership or prevent later schema changes.
