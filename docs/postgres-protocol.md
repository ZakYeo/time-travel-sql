# PostgreSQL capture protocol

The bootstrap and exact pgoutput decoder primitives are implemented and tested
against native PostgreSQL 16.15. Durable ingest, source-session orchestration,
preflight/setup commands, reconnection and cleanup UX are still in development.
These primitives alone are not a finished recorder.

## Snapshot ownership

`readSnapshot` creates a new persistent `tts_` slot through a replication-mode
connection and imports its exported snapshot into a separate repeatable-read,
read-only transaction. The exporter remains idle until import succeeds. Selected
tables are locked in ACCESS SHARE mode for the snapshot transaction; row writes
remain possible. Catalog metadata and rows are read in that same transaction.

The yielded `begin` part identifies the system, database OID, source position and
selected schema. Rows follow in bounded batches. A `complete` part is emitted
only after commit and connection shutdown succeed, with cancellation checked after
shutdown. Callers must stage all parts and publish no baseline until completion.
Breaking iteration closes both connections without yielding completion.

Baseline rows are limited to 1 MiB of encoded values; batches contain at most 16
rows. The source SELECT checks encoded byte lengths and returns only a rejection
marker for oversized rows, so they are never transferred as row values. This is
a bound on transferred values, not a promise that PostgreSQL spends no memory
evaluating source expressions. Row and schema validation remain necessary before
durable publication.

Failed/cancelled bootstrap retains its persistent slot. Retrying with the same
name fails; it does not create a replacement or invent stream continuity.
The surrounding lifecycle must surface the incomplete artifact and require
explicit owned-resource cleanup or a new epoch.

## Exact decoding and transport

The adapter uses `pg` and `pg-logical-replication` with pgoutput protocol 1.
Snapshot clients use local text parsers and fixed ISO/UTC/hex output settings.
The plugin replaces the decoder's cached relation-column parsers with text
parsers before tuple decoding. It never mutates pg's global parser registry.
Int8, numeric, timestamps, JSON numbers and bytea therefore remain text until the
canonical SDK value decoder validates them. SQL NULL remains null; unchanged
TOAST remains the library's undefined marker or its explicit old-tuple fallback.
Neither path queries current source values.

The transport library reads some unsigned identifiers as signed integers. The
adapter normalizes xid and relation/type OIDs at its boundary, including cached
relations. Protocol fixtures exercise identifiers above 2^31. Commit times are
bigint microseconds and remain separate from authoritative LSN ordering.

The plugin converts synchronous decoder exceptions into error frames for the
asynchronous consumer and bounds accepted messages (4 MiB by default). This
decoder limit is after the driver's wire-frame allocation; a final capture
worker memory limit is still required before claiming end-to-end hostile-frame
memory protection.

The real handoff test disables both automatic acknowledgement and its timer and
enables sequential flow control. Observation alone does not advance the slot.
Future durable acknowledgement must account for the library's `acknowledge`
adding one byte to its argument: commit-end positions are already exclusive.
It must also handle heartbeat replies using durable progress, never received WAL.

## Evidence and references

`npm run test:integration` creates private native clusters with Unix sockets,
disabled TCP listening and no ambient DATABASE_URL. Tests cover concurrent
multi-table commits during snapshot reading, transaction/savepoint rollback,
exact values, cancellation, size rejection, existing-slot retry and cleanup after
startup reports failure with an already-live postmaster.

The harness checks terminal process state before deleting its owned directory.
Uncertain cleanup fails and retains that directory for diagnosis.

- [PostgreSQL 16 replication commands and snapshot lifetime](https://www.postgresql.org/docs/16/protocol-replication.html)
- [Logical decoding consistency](https://www.postgresql.org/docs/16/logicaldecoding-explanation.html)
- [Transport source and public plugin API](https://github.com/kibae/pg-logical-replication)
