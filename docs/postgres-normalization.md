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

The full source-session contract, pgoutput transaction normalization, TOAST
resolution, schema-change boundaries, durable acknowledgements and reconnect
orchestration remain pending. This boundary test does not claim those capabilities.
