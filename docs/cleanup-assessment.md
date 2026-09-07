# Read-only cleanup assessment

`assessPostgresCleanup(connection, setupReceipt, signal)` inspects source resources
without deleting them. It validates canonical input and verifies cluster, timeline,
database and PostgreSQL 16 on the same replication-capable connection used for SQL.
The SQL transaction is read-only. Inspection does not acquire capture advisory locks,
so it can report active capture without stopping it.

The result includes publication ownership observations and an optional slot snapshot:
configuration compatibility, active use, restart/confirmed positions, WAL status,
and exact decimal retained/unconfirmed WAL byte distances from current WAL. These
byte distances are WAL-position arithmetic, not actual disk allocation, transaction
counts or application lag. Physical/incompatible slots and lost WAL remain visible;
assessment does not apply the stricter rules needed for resuming history.

The next action is deliberately conservative:

- `nothing-to-remove`: neither recorded resource was observed.
- `cleanup-publication`: the publication matched its OID/marker and the slot was
  absent. The existing guarded cleanup operation must revalidate before removal.
- `review-publication-ownership`: the publication was renamed, replaced or its
  marker differs.
- `review-slot-ownership`: a slot exists. This always applies regardless of matching
  configuration, progress, activity or publication marker.

These observations are not deletion authority and can become stale immediately.
Publication reads use a database snapshot; replication slot state lives outside
ordinary MVCC and can change during inspection. Current WAL is read after slot
progress to avoid reporting a position older than that observed progress.

## Outstanding slot-deletion requirement

Stock PostgreSQL 16 exposes slot identity by name, but no persistent slot owner,
creation identifier or atomic conditional drop matching a previously inspected
incarnation. Its drop implementation acquires the slot by name at deletion time.
Publication object locks do not lock slot lifetime. Capture advisory locks coordinate
cooperating callers, but arbitrary privileged clients can replace a slot between
inspection and deletion. A saved binding, published baseline or plausible LSN range
does not close that gap.

Accordingly, destructive slot cleanup remains unavailable and GOAL's cleanup
requirement remains incomplete. A stronger supported boundary would need an atomic
server-side incarnation check/drop primitive or independently established exclusive
control over slot mutation. Neither is inferred from a receipt or advisory lease.
This assessment does not emit a misleading safe-to-run drop command.

Slot removal also cannot be treated as rollback-safe publication DDL. A lost response
would require reconciliation, and a surviving publication after slot removal would
be a legitimate intermediate state in a future cleanup workflow.

The limitation follows PostgreSQL's [slot catalog](https://www.postgresql.org/docs/16/view-pg-replication-slots.html),
[drop protocol](https://www.postgresql.org/docs/16/protocol-replication.html) and
[slot implementation](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/replication/slot.c).
Native tests cover absent resources, compatible independently created slots, active
leased capture, physical replacement, actual lost WAL, changed markers and a
mismatched cluster. Existing publication race tests cover the shared identity refactor.
