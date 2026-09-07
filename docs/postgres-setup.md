# PostgreSQL setup

`planPostgresSetup` is pure: it validates unknown data and returns inspectable SQL
without opening a connection. Supply explicit tables, `tts_` publication/slot
names and a fresh 128-bit lowercase hexadecimal ownership token from composition.
Persist that token and the plan before applying setup so an uncertain outcome can
be inspected. The SDK's small data-object/array decoders are shared by this adapter
boundary; accessors, sparse arrays and unexpected fields are rejected.

The script changes replica identity to FULL on selected tables and creates an exact
publication with all change kinds enabled. Every table reference uses `ONLY`, so
ordinary inheritance cannot expand scope or alter descendants. It adds a versioned
publication comment containing the ownership token and intended slot name. Names
are quoted, and malformed Unicode or oversized identifiers are rejected.

`applyPostgresSetup` requires an explicitly chosen connection. It checks that the
publication and intended slot names are unused, applies the plan transactionally,
validates the resulting supported catalog/publication, and commits. A five-second
lock timeout and thirty-second statement timeout bound individual SQL waits.
Cancellation closes the owned connection. Errors before COMMIT roll back all table
settings and publication creation; existing resources are never replaced.

The operator needs replication permission for the identity probe, database CREATE
and ownership rights on selected tables. Native tests exercise a non-superuser
with those rights. Setup does not change server WAL settings, roles or grants.
The pure SQL script does not itself perform the apply operation's extra catalog
and resource-name checks; use the API for the validated setup path.

The slot is created later by `openPostgresBaseline`, which imports its exported
snapshot while the exporting connection remains valid. The plan exposes that
replication-protocol command separately; it is not ordinary setup SQL. Precreating
a slot through this script would break the coordinated bootstrap contract.

If transport fails during COMMIT, setup may have committed even though the caller
received an error. Do not rerun or replace resources automatically.
`inspectPostgresSetup` reads the existing publication in a read-only repeatable-read
transaction and requires the exact marker, selected catalog and publication scope.
It recovers the receipt for the matching plan; a mismatched token fails. A native
TCP proxy test discards the server's successful COMMIT response, then verifies
receipt recovery through a fresh connection and rejection of duplicate apply.

The receipt combines a replication identity probe with a separate parameterized SQL
connection. PostgreSQL rejects extended query protocol on replication connections;
the native tests exposed and verified this transport boundary. Routing can mix
observations, so the receipt does not prove cluster affinity, exclusive capture
ownership or slot ownership. Actual capture must validate its own identity.

The marker is an ownership label, not a secret or protection against a privileged
database operator. Guarded resource deletion, persistent ownership records, shared
replica-identity restoration policy and recorder orchestration remain pending.
Closing setup or capture does not remove the publication or persistent slot.
FULL identity affects WAL volume and other consumers of the selected tables;
automatic restoration would require proving that no other consumer relies on it.

References: [PostgreSQL 16 publications](https://www.postgresql.org/docs/16/sql-createpublication.html),
[replica identity changes](https://www.postgresql.org/docs/16/sql-altertable.html),
and [replication protocol](https://www.postgresql.org/docs/16/protocol-replication.html).
