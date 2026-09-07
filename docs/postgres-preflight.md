# Read-only PostgreSQL preflight

`inspectPostgresCapture(options)` first owns a short-lived replication connection
for authentication and `IDENTIFY_SYSTEM`, then a separate SQL connection for a
read-only repeatable-read catalog inspection. Options explicitly supply
connection settings, selected tables, publication, schema ID and AbortSignal.
It returns the exact cluster system ID, timeline, database OID, canonical schema
and optional retained-slot status.
It creates no slot/publication and changes no table or server configuration.

The check requires a primary with logical WAL, replication-role permission,
enabled slots/senders, schema USAGE and full-table SELECT. Existing catalog
inspection validates the supported physical table/type/key/replica-identity
projection. Publication membership must equal the selected relation OIDs, without
row filters, column lists, all-table/schema expansion or partition-root mapping.
All change kinds must be published, so unsupported changes can end coverage
explicitly instead of disappearing. These predicates use PostgreSQL's
[publication catalog](https://www.postgresql.org/docs/16/catalog-pg-publication.html).

Resume first rejects changed cluster system IDs or timelines. It additionally
compares the database OID and complete canonical catalog
schema, including primary keys and nullability, with recorded metadata. The slot
must be persistent, inactive, logical pgoutput for that database, without two-phase
or recovery-conflict state. Its required WAL must remain reserved or extended.
Restart/confirmed positions cannot exceed local durable progress, and local
progress cannot exceed current source WAL. Missing slots are errors, never a reason
to create a replacement. PostgreSQL documents these fields in
[pg_replication_slots](https://www.postgresql.org/docs/16/view-pg-replication-slots.html).

This is a point-in-time check, not exclusive resource ownership or a full resume
protocol. Slot state can change concurrently. Replication identity and SQL catalogs
come from separate connections: a routing endpoint can produce a mixed report.
Use a direct stable endpoint, and revalidate identity on the actual capture
connection before using the retained slot. Database OID alone does not detect every
recreated resource; same-system restores/clones require ownership and continuity
checks too. The source session must still record ownership, reserve the actual
slot, enforce schema boundaries during capture and handle missing WAL/reconnect/
crash windows. Replication authentication is now probed, but available runtime
capacity and local storage access remain separate checks. The full doctor CLI and
setup/cleanup commands remain pending.

`inspectPostgresIdentity(connection, signal)` exposes the read-only replication
probe separately. The returned system ID and timeline are exact unsigned decimal
strings; the current WAL position uses the SDK Position type. Database name must
match the explicitly configured database. Snapshot bootstrap reuses this decoder
on its exporting connection before creating the slot and includes the timeline in
its begin metadata. Neither helper mutates a global driver parser or creates a
slot merely to identify the server.

Cancellation closes the owned client and explicitly settles connection startup.
The pinned pg driver may resolve end() while leaving connect() pending during
authentication; the shared connect helper therefore cannot rely on that callback.
The same fix protects exported-snapshot reader and exporter startup. Tests use a
private server that stalls authentication and verify rejection plus socket closure.

Native tests exercise publication operations, filters/projections/extra tables,
replica identity, catalog-only nullability changes, missing/advanced/active slots,
future local progress, replication/SELECT/schema-USAGE permissions and cancellation.
A two-cluster native test proves rejection despite matching database and table
OIDs. Tests inspect slot counts to verify that preflight creates no source resources.
Diagnostics expose fixed safe messages; retained error causes are for controlled
internal handling, not unrestricted rendering of driver errors or connection data.
