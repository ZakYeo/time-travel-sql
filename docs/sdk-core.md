# Canonical SDK state model

The SDK currently provides a dependency-free deterministic core. Storage ports,
ingestion orchestration, indexed inspection, checkpoints and public adapter
conformance are still in development; this document does not claim those APIs
already exist.

## Values and schema

Schema format version 1 selects the version 1 tagged-value encoding. Values are
`{kind: 'null'}`, `{kind: 'unavailable', reason: 'redacted' | 'excluded'}`, or
`{kind: 'scalar', type, value: string}`. The column type is explicit; no scalar
passes through a JavaScript floating-point value. Missing and unchanged source
fields are not canonical values: adapters must resolve them against recorded
history or fail before constructing a complete row.

`scalarValue` normalizes boolean, UUID, integer, byte and timestamp representations.
Numeric and JSON text retain their recorded representation. `valueIdentity`
provides typed SQL-equality identities separately: numeric scale, JSONB object
ordering and equivalent JSONB number notation do not create different keys.
JSON numbers are validated with a bounded parser without converting number
tokens to JavaScript numbers. JSONB additionally enforces PostgreSQL's Unicode
and numeric restrictions; JSON preserves its distinct lexical semantics.

Supported scalar types are bool, int2/int4/int8, numeric, text/varchar, UUID, date,
timestamp/timestamptz, JSON/JSONB and bytea. Arrays/custom types and non-finite
numeric/temporal values are rejected. Calendar values cover years 0001–9999;
timestamps retain six fractional digits. Zoned timestamps must arrive normalized
to UTC. Ordinary numeric limits are PostgreSQL's 131072 integer digits and 16383
fractional digits, within the overall value byte bound. JSON nesting is at most
64 levels and 100000 nodes. JSONB exponent notation also has a bounded lexical
exponent (absolute value at most one million); representability checks apply.

Schema validation requires distinct stable table identities and qualified names,
unique columns and nonnullable primary-key columns. JSON cannot be a key because
it lacks SQL equality. Composite keys use schema column names in their declared
key order. Available scalar values are mandatory for every key component.

Type modifiers are validated centrally: varchar character limits, timestamp
precision 0–6, and PostgreSQL numeric precision/scale including negative scales.
Rows that would round, truncate or overflow their declared column are rejected.
Types without modifiers require the unmodified marker `-1`.

## Committed replay

`HistoryState.fromSnapshot(recording, position, rows)` validates a recording schema
containing separate `sourceId`, `epochId` and `schema.id`, then consumes baseline
entries shaped as `{tableId, row}`. Rows are immutable arrays in schema column
order. The state owns private maps; returned rows and decoded metadata are frozen.

`state.apply(transaction)` accepts an ordered, complete commit with matching
source/epoch/schema identities, an ID, position, predecessor position and ordered
insert/update/delete events. Inserts carry `after`, deletes carry `before`, and
updates carry both full row images. Key changes and repeated updates are replayed
in event order. Events do not become separately selectable committed states.

Application is atomic: touched table maps are copied and validated before a new
state is returned. Missing rows, stale before-images, key collisions, incompatible
schema and missing predecessors fail without changing the original state.
Rows are returned in deterministic encoded-key order, not numeric key order.

An identical immediate redelivery returns the same state; divergent redelivery
fails. Durable storage must additionally compare older duplicate positions against
indexed authoritative history. The core does not pretend to retain an entire
transaction log inside every reconstructed state.

Limits: at most 64 tables, 128 columns/table, 32 key columns, 64 KiB encoded keys,
1 MiB encoded rows and 10000 events / 16 MiB encoded event-array bytes per commit.
UTF-8 bytes include serialization framing. Full-state memory currently depends on
baseline size and retained immutable states; worker/storage limits and measured
large-history performance remain required before release.

## Verification

`test/unit/replay.test.ts` compares 300 committed boundaries against an independent
seeded reference model and tests atomic failure, key changes, stale images,
duplicate delivery and identity mismatches. Value boundary tests exercise UTF-8,
JSONB restrictions, precision modifiers and malformed external structures.

`test/integration/value-fidelity.test.ts` compares every supported scalar type
against actual PostgreSQL and verifies JSONB rejection cases independently.
These tests supplement the separate source snapshot/stream handoff tests.
