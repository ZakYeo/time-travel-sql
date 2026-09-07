# Composed recording resume

`resumeRecording(store, reconstructor, provider, recordingId, signal?)` performs
one resume attempt. It reads canonical resumable metadata and the immutable source
binding, acquires source ownership, restores the durable head, rechecks recording
identity/binding, opens retained source resources and starts the recorder loop.
`createPostgresResumeProvider(connection)` supplies PostgreSQL behavior using
runtime credentials and the stored canonical setup receipt.

**The caller must hold exclusive local recording ownership from before invocation
until the returned session's completion settles.** A source advisory lease may be
lost before an accepted local append and its lifecycle update finish. Another
recorder must not restore/start concurrently in that interval. Source ownership
does not fence local writes; durable local fencing remains required work. A caller
that cannot establish this precondition must not use this primitive for overlapping
or automatic recovery.

The operation owns the acquired source lease and the opened stream. Store and
reconstructor ownership remain with the caller. Startup failures close all acquired
resources and preserve the previous lifecycle. Once streaming starts, recorder
failure/stop behavior applies. The returned `done` and `stop()` wait for lease release
as well as stream completion, preserving primary and cleanup errors. A lease cleanup
failure after a successfully persisted stop is still reported as a completion error.

PostgreSQL acquisition connects using explicit runtime options and checks the saved
receipt on the actual source connection. Stream startup uses retained-slot preflight;
it never creates a replacement slot or publication. Caller cancellation remains
connected to the lease for its lifetime, and lease loss cancels restoration or
streaming. Missing bindings, changed source/schema identity and missing retained
resources reject without discarding local history.

Unit tests cover acquisition order, pending lease cleanup, missing/changed bindings,
failed acquisition/restoration/open, mismatched streams and aggregate terminal errors.
The serial native fixture supplies local exclusivity while testing retained WAL,
external cancellation, ownership release, another resume and missing-slot rejection
without replacement. It does not prove safe overlapping recorder processes.

Durable local fencing, automatic retry/reconnect policy, persisted error diagnostics,
full process-crash barriers and guarded slot cleanup remain pending.
