# Composed recording resume

`resumeRecording(store, reconstructor, provider, recordingId, signal?)` performs
one resume attempt. It reads canonical resumable metadata and the immutable source
binding, acquires source ownership, restores the durable head, rechecks recording
identity/binding, opens retained source resources and starts the recorder loop.
`createPostgresResumeProvider(connection)` supplies PostgreSQL behavior using
runtime credentials and the stored canonical setup receipt.

Before source acquisition, the operation reserves a durable local writer generation.
After acquisition it activates that generation, fencing earlier writers before
restoring the head. Reservation alone does not displace a running writer. A delayed
activation cannot supersede a newer activated generation, even after its release.
SQLite checks append and lifecycle ownership in the same transaction as each write.
A per-recording incarnation prevents stale handles from affecting a deleted and
recreated recording. Source providers must still enforce exclusive acquisition.

The operation owns the acquired source and local writer leases and the opened stream. Store and
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
Direct storage regressions cover two workers, generation ordering beyond JavaScript
integer precision, stale releases, deletion/recreation, queue saturation and migration.
Composed regressions delay old append and activation until after a replacement starts.
The native fixture tests retained WAL, external cancellation, ownership release,
another resume and missing-slot rejection without replacement.

Automatic retry/reconnect policy, persisted error diagnostics, full process-crash
barriers and guarded slot cleanup remain pending.
