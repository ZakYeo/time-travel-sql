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
Capture/resume and guarded source cleanup CLI composition remain pending.
