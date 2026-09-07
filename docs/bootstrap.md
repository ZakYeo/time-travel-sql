# Consistent baseline ingestion

The SDK `SourceBaseline` port exposes a canonical recording schema, a consistent
source position and bounded batches. Its owner must close it. `next()` returns
nonempty batches of at most 100 rows and 16 MiB of canonical snapshot-entry JSON.
Only `null` certifies complete capture and successful source-side cleanup.
Cancellation and failures reject; they cannot stand in for completion.

`bootstrapRecording` owns this baseline source. It validates recording metadata,
source schema/position and every batch before staging. Aggregate row/key bytes and
row count use the same configurable logical limits as replay, without retaining
the complete baseline in application memory. The durable writer must reject
duplicate keys and validate the complete staged state when publishing.

For sources that allocate persistent resources on open, use `SourceCapturePlan`
with `bootstrapBoundRecording`. The plan exposes the intended recording schema,
immutable capture binding and a deferred `openBaseline()` factory. Bootstrap first
validates the plan, creates local metadata and durably binds it, then opens the
source. Binding failure never calls the factory. The opened baseline must match
the planned canonical recording, including source, epoch and schema. Both bootstrap
entry points share batch validation, publication and cleanup behavior.

`planPostgresCapture({ connection, lease, sourceId, epochId, signal })` derives
selection from an acquired lease's setup receipt. Planning creates no slot; the
deferred open verifies actual source identity and creates it. The caller owns the
lease throughout bootstrap and any subsequent streaming and must close it. A rejected
factory must release its own connections; persistent resources remain subject to
explicit guarded cleanup.

Publication occurs only after source completion and successful explicit close.
Any failed attempt invalidates the newly created artifact. If invalidation itself
fails, its error is preserved alongside the primary failure and source cleanup
failure; the artifact remains explicitly bootstrapping. A failed create never
invalidates a pre-existing recording. A crash before publication leaves an
unpublished staging artifact. The operation does not retry or replace it.

`openPostgresBaseline` adapts the exported-snapshot primitive to this contract.
It returns cluster system ID, timeline and database OID alongside the canonical
schema/position so composition can supply them to stream preflight. It creates a
new persistent slot and retains it after closure/failure. The imported snapshot
remains owned until all batches are consumed or the baseline is closed. Successful
completion follows transaction commit and connection cleanup.

The adapter fetches at most fifteen rows per batch, leaving framing space even
when each canonical row reaches its 1 MiB ceiling. A requested batch size of 16
therefore uses 15; smaller valid sizes are preserved. Pending-read close aborts
owned work; idle close releases connections without manufacturing a capture
completion. Internal and external cancellation use `HistoryError(CANCELLED)`.
Connection and cleanup errors remain observable.

Native evidence covers a commit made after snapshot opening but before row
ingestion: the published baseline contains the old rows and the live stream
records that commit exactly once through the public SDK/SQLite APIs. Additional
tests cover pending/idle close, external idle cancellation and maximal-size rows.
SDK tests cover delayed close before publication, source/duplicate/empty-batch/
limit/close failures, failed creation and aggregate cleanup failures.
Bound-bootstrap tests additionally cover binding/open/schema failures and existing
recording preservation. Native evidence checks the binding through an independent
SQLite connection before the real PostgreSQL slot-creating open.

Durable capture bindings and inspectable setup are implemented separately. Full
recorder lifecycle, slot generation ownership/cleanup, automatic recovery, checkpoint
scheduling, catalog drift enforcement and complete crash-window coverage remain
outstanding. Driver allocations and measured process
memory are outside the logical row/batch limits.
