# Guarded publication cleanup

`cleanupPostgresPublication(connection, receipt, signal)` explicitly removes the
publication identified by a canonical setup receipt. It returns `removed`, or
`absent` when neither the recorded name nor OID exists. It rejects renamed or
replaced publications, mismatched ownership markers, database/cluster/timeline
differences, and an extant intended slot. It leaves table replica identity and all
slots unchanged. Slot ownership and cleanup remain a separate pending operation.

Cleanup validates the receipt before connecting. It runs `IDENTIFY_SYSTEM` on the
same replication connection used for its SQL, so deletion does not rely on the
setup receipt's separate-connection observation. Replication connections accept
simple SQL; interpolated names are restricted to validated lowercase ASCII slot
names and numeric IDs to canonical bounded decimal strings. Identifiers are quoted.

The transaction checks publication name/OID, then renames that object to a temporary
name derived from its ownership token. PostgreSQL's rename operation acquires an
exclusive object lock. After acquiring it, cleanup rechecks the OID and marker,
then drops that locked object and commits. A failure before COMMIT rolls back
the temporary rename. A collision with an existing temporary name fails without
replacing it. Lock waits are bounded to five seconds and SQL statements to thirty.

Native races change the marker or drop/recreate the publication while cleanup is
waiting. The post-lock check rejects both and preserves the competing transaction's
publication. Tests also cover a non-superuser owner, another real cluster with a
matching publication OID/marker, retained unrelated resources, malformed receipts,
and a lost successful COMMIT response. Retry after that lost response returns
`absent`; it never drops an object newly created under the old name.

Slot absence is checked before and after the publication lock wait. A native test
creates a slot during that wait and verifies refusal plus rollback. These are
point-in-time checks: arbitrary concurrent slot creation can still occur before
COMMIT. The primitive acquires the cooperative capture locks used by setup and capture.
Durable bindings and local writer fencing are implemented, but neither establishes
slot incarnation ownership or guarantees slot absence against arbitrary SQL.
Guarded slot deletion and shared table-configuration restoration remain outstanding.
`assessPostgresCleanup` provides read-only next-step observations; see
`docs/cleanup-assessment.md`. The publication marker is not a security boundary
against a privileged database operator.

Lock behavior was checked against PostgreSQL 16's
[rename implementation](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/commands/alter.c)
and [comment implementation](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/commands/comment.c),
then exercised by actual concurrent PostgreSQL sessions.
