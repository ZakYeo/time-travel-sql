# Durable capture bindings

`HistoryCaptureBindings` stores an immutable `CaptureBinding` for a recording.
The portable envelope contains an adapter identity, positive integer format version
and a nonempty UTF-8 payload bounded to 1 MiB. The source adapter owns payload
semantics. The generic store cannot identify secrets in arbitrary custom payloads;
custom adapters must exclude credentials and validate metadata before reuse.

`bindCapture(id, binding)` requires a bootstrapping recording for its first write.
An identical retry is allowed after publication; replacement is always rejected.
`captureBinding(id)` returns null when no binding exists. Missing metadata must never
be interpreted as permission to recreate or adopt a source resource. Binding writes
and checks run in one SQLite transaction, so competing processes cannot replace
each other's binding. Recording deletion cascades to the attachment.

SQLite version 3 adds a dedicated table with a digest over the binding and recording
ID. Reads reject damaged payloads and data copied from another recording. This is
corruption detection, not authentication against a writer who can recompute hashes.
Migration preserves old history; read-only reconstruction also continues to accept
intact version-2 databases without creating binding tables.

For PostgreSQL, `createPostgresCaptureBinding(recording, receipt)` stores only the
canonical setup receipt plus source and epoch IDs. It verifies the recording schema
and rejects extra receipt fields, including connection credentials. After reopening,
`readPostgresCaptureBinding(recording, binding)` validates the adapter/version,
payload, source, epoch and schema before returning a receipt for lease acquisition.
Connection options must be supplied separately at runtime.

`bootstrapBoundRecording` persists the recording and binding before opening a source
plan. `planPostgresCapture` supplies that plan from an owned lease. If local binding
fails, the slot-creating factory is never called. A native test reopens the store at this
boundary, acquires the recovered lease, captures and publishes a baseline, stops,
reopens again and reacquires the lease while retaining the slot.

The binding is restart metadata. It does not prove slot generation ownership or
authorize slot deletion. Full orchestration, crash recovery and guarded slot cleanup
remain pending; callers still own lease/baseline/stream lifetimes explicitly.
