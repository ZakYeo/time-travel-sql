# Read-only PostgreSQL preflight

`inspectPostgresCapture(options)` owns one short-lived SQL connection and inspects
PostgreSQL 16 in a read-only repeatable-read transaction. Options explicitly supply
connection settings, selected tables, publication, schema ID and AbortSignal.
It returns the database OID, canonical schema and optional retained-slot status.
It creates no slot/publication and changes no table or server configuration.

The check requires a primary with logical WAL, replication-role permission,
enabled slots/senders, schema USAGE and full-table SELECT. Existing catalog
inspection validates the supported physical table/type/key/replica-identity
projection. Publication membership must equal the selected relation OIDs, without
row filters, column lists, all-table/schema expansion or partition-root mapping.
All change kinds must be published, so unsupported changes can end coverage
explicitly instead of disappearing. These predicates use PostgreSQL's
[publication catalog](https://www.postgresql.org/docs/16/catalog-pg-publication.html).

Resume additionally compares the database OID and complete canonical catalog
schema, including primary keys and nullability, with recorded metadata. The slot
must be persistent, inactive, logical pgoutput for that database, without two-phase
or recovery-conflict state. Its required WAL must remain reserved or extended.
Restart/confirmed positions cannot exceed local durable progress, and local
progress cannot exceed current source WAL. Missing slots are errors, never a reason
to create a replacement. PostgreSQL documents these fields in
[pg_replication_slots](https://www.postgresql.org/docs/16/view-pg-replication-slots.html).

This is a point-in-time check, not exclusive resource ownership or a full resume
protocol. Slot state can change concurrently. Database OID alone does not establish
cluster identity or detect every recreated resource. The source session must still
verify system identity, record ownership, reserve the actual slot, enforce schema
boundaries during capture and handle missing WAL/reconnect/crash windows. SQL-role
inspection does not prove replication-connection authentication, available runtime
capacity or local storage access. The full doctor CLI and setup/cleanup commands
remain pending.

Cancellation closes the owned client and explicitly settles connection startup.
The pinned pg driver may resolve end() while leaving connect() pending during
authentication; the shared connect helper therefore cannot rely on that callback.
The same fix protects exported-snapshot reader and exporter startup. Tests use a
private server that stalls authentication and verify rejection plus socket closure.

Native tests exercise publication operations, filters/projections/extra tables,
replica identity, catalog-only nullability changes, missing/advanced/active slots,
future local progress, replication/SELECT/schema-USAGE permissions and cancellation.
Tests inspect slot counts to verify that preflight creates no source resources.
Diagnostics expose fixed safe messages; retained error causes are for controlled
internal handling, not unrestricted rendering of driver errors or connection data.
