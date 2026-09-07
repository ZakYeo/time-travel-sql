# Cooperative capture leases

`openPostgresCaptureLease(connection, receipt, signal)` validates a canonical setup
receipt, verifies the actual connection's cluster/timeline/database and publication
OID/marker, and holds two session advisory locks for the publication and slot names.
Setup and publication cleanup acquire the same locks. Failed acquisition closes the
connection, releasing even a partially acquired pair. Explicit close is idempotent.

Pass the lease to `openPostgresBaseline` and `openPostgresStream` to bind their
resource selection and cancellation to its lifetime. Losing the lease connection
aborts these operations. A nonoverlapping health query runs one second after each
successful probe, with a five-second query deadline. Silent transport failure is
therefore detected in approximately six seconds plus scheduling delay. Callers own
and must close the lease as well as their baseline/stream.

Both actual snapshot connections use replication-capable sessions and verify their
cluster, timeline and database before creating a persistent slot. The reader uses
simple SQL queries because this protocol does not support parameterized extended
queries. Catalog identifier values are validated and escaped explicitly. Streaming
also rechecks database OID on the actual replication connection before starting.

These locks coordinate cooperating adapter callers in one database. PostgreSQL
does not enforce advisory locks against arbitrary SQL or replication clients; they
do not establish slot generation ownership or prevent administrative mutation.
See PostgreSQL's [advisory lock semantics](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS).
Durable capture bindings, owned recorder sessions, local writer fencing and bounded
reconnect are implemented. Guarded slot deletion remains unresolved; see
`docs/cleanup-assessment.md`. The lease itself remains a composition primitive.

Native tests cover competing acquisition/setup/cleanup, failed-acquisition release,
stalled health replies and termination of the specifically verified lease backend
while streaming. A two-cluster routing proxy proves a mismatched snapshot reader
is rejected before either cluster acquires a slot. A separate regression exercises
catalog names containing apostrophes, backslashes, Unicode and SQL punctuation.
