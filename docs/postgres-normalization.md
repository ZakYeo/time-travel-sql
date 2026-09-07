# PostgreSQL canonical values

`postgresSchema(schemaId, tables)` converts inspected PostgreSQL catalog metadata
into the canonical SDK schema. Relation IDs use `pg_` plus the unsigned relation
OID. Those IDs are scoped by the SDK's source, epoch and schema identity; an OID
alone does not identify a source or prove safe resume.

Column order follows the catalog's physical attribute order. Primary-key order
follows the primary index, independently of column order. Key ordinals must be
contiguous and unique. The SDK validates names, duplicate tables/columns, key
eligibility, type modifiers and schema limits.

The adapter has one OID-to-scalar mapping shared by catalog inspection and schema
conversion. Supported built-ins are boolean, int2/int4/int8, numeric, text,
varchar, UUID, date, timestamp, timestamptz, JSON, JSONB and bytea. Other OIDs fail
explicitly. Domains and extension types are not silently treated as built-ins.

`postgresRow(table, rawValues)` converts complete driver text rows to SDK rows.
It creates tagged inputs and delegates normalization, exact validation, typmod
checks, nullability and size bounds to `decodeRow` once. SQL NULL remains distinct
from text and JSON null. Missing values and unchanged TOAST markers fail here;
the replication normalizer must resolve TOAST from recorded prior values before
using this complete-row conversion. It must never query a current source row to
repair history.

These are typed helpers for owned catalog/driver values, not arbitrary imported
configuration decoders. The original exported-slot snapshot API remains available.
An actual native PostgreSQL integration test now imports its schema and rows into
SQLite through public package APIs, publishes only after snapshot completion and
reconstructs the exact persisted values. It checks all supported types and a
composite primary key whose order differs from physical column order.

The full source-session contract, complete schema-change boundaries and reconnect
orchestration remain pending. Bounded assembly and durable confirmation are
documented in `postgres-transactions.md`. Row-change normalization follows below. This boundary test does not claim those capabilities.

## Replication row changes

`postgresChange(recording, message, readRow)` turns an insert, update or delete
from `ExactPgoutputPlugin` into a canonical SDK row event. On every change it
checks the wire relation's OID, names, column order, types, modifiers and FULL
replica identity against the recording. `postgresRelation` exposes that check
for relation messages as well. Unknown or changed relations fail explicitly.
Wire relation metadata cannot prove that primary keys, nullability or other
catalog-only properties remain unchanged; source-session catalog enforcement is
still required.

For updates and deletes, the FULL before-image supplies the primary-key lookup.
The injected synchronous `readRow` must read recorded transaction-local state,
including earlier changes in the same transaction. The helper resolves explicit
unchanged markers from that row, verifies the complete before-image and resolves
new unchanged values from the verified before-image. It never mutates state or
opens a connection. The caller owns atomic transaction assembly, replay validation
and durable append before acknowledgement. Inserts still require collision checks
when replayed; a normalized event is not proof of a valid committed transaction.

Missing columns, accessors, binary values, missing prior rows, unavailable fallback
values and stale before-images fail. Explicit SQL NULL remains NULL. Primary-key
changes preserve separate before/after identities. The transport library can
already fill a new unchanged marker from the same message's old tuple; that old
tuple must still agree with recorded state.

Unit tests explicitly cover unresolved unchanged markers, NULL, missing/stale
history, relation drift, key changes and a column named `__proto__`. A native
PostgreSQL test captures repeated updates to a 32 KB externally stored text value,
a key change, deletion and insertion in one transaction, then normalizes against
recorded transaction-local rows. This supplements the snapshot boundary test;
bounded transaction assembly and exact commit times are now implemented in
`postgres-transactions.md`; complete schema enforcement and lifecycle remain pending.
