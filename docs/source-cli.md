# PostgreSQL source CLI

`source-plan`, `source-setup`, `source-inspect` and `source-doctor` accept an
explicit source JSON file. They do not need or create a local workspace.
Relative source paths use the working directory. Global `--timeout-ms`, `--config`
and `--json` options retain their ordinary CLI behavior.

```json
{
  "connection": {
    "host": "localhost",
    "port": 5432,
    "user": "capture_operator",
    "database": "application",
    "passwordEnv": "TTS_SOURCE_PASSWORD",
    "sslMode": "verify-full"
  },
  "schemaId": "initial-schema",
  "publication": "tts_application",
  "slot": "tts_application",
  "ownershipToken": "0123456789abcdef0123456789abcdef",
  "tables": [{ "namespace": "public", "name": "orders" }]
}
```

Generate a fresh random 128-bit ownership token (32 lowercase hexadecimal digits)
for each new setup; the example token is illustrative. Preserve the configuration
for subsequent inspection. Select 1–64 distinct supported tables explicitly.
Configuration is bounded to a regular 64 KiB UTF-8 JSON file with known fields.

Optional `columnPolicy` rules redact or exclude selected non-key columns before
persistence. Setup validates the policy atomically, doctor reports `lossy`, and
resume requires the recorded policy. See [column policy](column-policy.md).

```sh
tts source-plan ./source.json --json
tts source-setup ./source.json --json
tts source-inspect ./source.json --json
tts source-doctor ./source.json --json
```

Planning is entirely offline and does not resolve the password reference.
Connected commands resolve only the named environment variable. Inline passwords
are rejected. Omitting `passwordEnv` explicitly selects an empty password;
ambient `PGPASSWORD` and pgpass files cannot supply one. TLS mode must explicitly
be `verify-full` (certificate verification) or `disable`. Host, port, user,
database, replication mode, encoding and TLS negotiation are explicit driver
settings, independent of ambient PostgreSQL environment variables.

The shared immutable `Sql` builder quotes dynamic identifiers and constructs
setup fragments; ordinary query values use driver parameters. The plan exposes
setup SQL for inspection. Setup atomically changes selected tables to
`REPLICA IDENTITY FULL` and creates the publication and ownership comment. It
rejects an existing publication or configured slot. It does not create a slot;
the plan's separate bootstrap command belongs to snapshot capture orchestration.
If result delivery fails after commit, setup may already have completed. Inspection
can validate the matching current setup and return its receipt.

Doctor verifies PostgreSQL 16 primary/logical-WAL prerequisites, replication and
table permissions, supported schema, the exact publication, configured slot-name
absence and available slot capacity. Its `ready` result is a point-in-time
assessment, not a reservation or exclusive capture lease. Inspection receipts
likewise describe current observations, not proof of an existing slot's ownership.
Capture/resume is described below. Guarded source cleanup CLI composition remains pending.

## Record, stop and resume

Initialize a workspace and apply explicit source setup first. Recording creates a
logical replication slot with an exported consistent snapshot; publication setup
is never applied implicitly. Source table replica identity and the publication
remain as established by `source-setup`.

```sh
tts init --workspace ./history
tts record orders-session 'Order investigation' ./source.json --workspace ./history --duration-ms 60000 --timeout-ms 90000 --json
tts resume orders-session ./source.json --workspace ./history --duration-ms 60000 --timeout-ms 90000 --json
```

`record ID NAME SOURCE_CONFIG` persists a new recording identity, source/epoch,
setup binding and baseline, then streams complete commits through the canonical
recorder. IDs must be new. The snapshot lease is released before the canonical
resume path reacquires it; retained WAL bridges that interval. A failed bootstrap
is invalid, never a usable partial baseline. Source credentials are resolved at
runtime and excluded from the stored binding.

`resume ID SOURCE_CONFIG` requires a compatible durable head and matching source
configuration. The expected binding remains pinned through acquisition and bounded
retries; replacing a recording concurrently cannot redirect capture to a different
slot or epoch. Missing/invalid retained WAL, changed source/schema, ownership loss
and missing slots fail explicitly. Resume never creates a replacement slot.

`--duration-ms` (1–3600000) requests successful stop after that much session time,
including acquisition/retry time but excluding initial configuration and bootstrap.
It is not a promise to have caught up with all current source writes. The independent
`--timeout-ms` deadline still covers the whole command, defaults to 30000 and has a
3600000 maximum. Choose it longer than duration plus expected bootstrap time.
Without duration, capture runs until failure, deadline or a signal.

SIGINT/SIGTERM and deadline expiry request session stop: accepted appends drain,
owned connections close, and retained resources support later resume. Signal exits
130; command deadline exits 124. Once streaming is active, successful shutdown
persists `stopped`; cancellation during bootstrap can leave an invalid recording.
A successful duration stop exits 0 with final recording information on stdout.
Independent capture/storage/cleanup failure remains an error and must not be
mistaken for successful shutdown.

Progress goes to stderr as newline-delimited version-1 `capture-progress` JSON
with `recordingId` and `data.phase`. Session events include retry status, lifecycle
status, baseline/head positions and transaction count. Bootstrap emits its phase
before snapshot work. There is at most one outstanding progress delivery, bounded
to one second; session completion cancels stalled progress. Errors also go to
stderr with the ordinary CLI error envelope. Stdout retains one final result.
Progress is structured in both output modes. It contains no row values or source
credentials. `inspect ID` reports durable status from another process.

Stopping retains the logical slot and publication. PostgreSQL can retain WAL while
a recording is stopped; operators must monitor source disk/retention. Guarded slot
cleanup remains incomplete; a slot name or setup marker is not sufficient proof
for destructive cleanup.
