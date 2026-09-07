# PostgreSQL transaction assembly

`PostgresTransactions` consumes `PgoutputFrame` values from one protocol-v1 stream
and an immutable verified `HistoryState`. It resolves row changes against a bounded
transaction-local overlay and emits only complete canonical committed transactions.
`HistoryState.row(tableId, rowKey)` provides immutable indexed prior-row lookup.
The overlay is a lookup projection, not a second replay validator: the canonical
SDK replays the original full event sequence before any commit can be returned.

The assembler has four phases: idle, collecting, pending durable confirmation and
closed. Begin records the final commit LSN, unsigned xid and exact commit time.
Commit must agree with begin and have a strictly later exclusive end position.
Source positions determine order even when commit times tie or go backwards.
Transaction IDs combine xid and commit-end position, scoped by source and epoch.

A returned transaction does not advance `durableState`. The caller must append
it durably, then call `confirmDurable(transaction.position)` before supplying
another frame. Confirmation advances the immutable head but sends no network
acknowledgement. The pinned replication library adds one to the byte position
passed to `acknowledge`; pass exclusive durable commit-end minus one. Heartbeat
handling must likewise acknowledge only verified durable progress, never the
latest observed server WAL position.

Any parse, ordering, normalization, replay or budget failure closes the assembler.
`close()` discards partial and unconfirmed work and retains the last confirmed
head. Restart requires a new assembler from verified durable state. Closing a
partial transaction does not claim a clean end of source coverage; the owning
source session must mark interruption. An incorrect durable confirmation or a
frame sent while confirmation is pending also fails closed.

Default transaction bounds are 100,000 wire messages, 64 MiB of wire payload,
10,000 canonical events and 16 MiB of encoded event-array data. Limits may be
lowered; event bytes cannot be below two because even `[]` occupies two bytes.
Wire accounting includes begin, relation and commit frames within a transaction.
Events are charged before retention in the overlay. Canonical replay additionally
honours the supplied state's row/count limits. These bounds exclude driver wire
allocation and total process memory; the source session still needs ownership,
timeouts and a measured memory envelope.

`committedAtMicros` is a canonical signed decimal string of Unix microseconds on
SDK transactions. It is optional for existing/custom histories with unknown time;
absence preserves their original canonical serialization and checksums. The
PostgreSQL assembler always supplies it. The transport plugin reads the signed
wire timestamp directly because the pinned library treats it as unsigned; the
PostgreSQL epoch is converted exactly once, without JS number or Date conversion.
Timestamp-to-position selection and presentation remain subsequent work.

The assembler currently accepts begin, relation, insert, update, delete and commit.
Other message kinds fail explicitly; truncate, replication origins and logical
context messages are not silently discarded. Complete source-session orchestration
must add the intended policies, catalog-based schema enforcement, slot ownership,
resume/reconnect, crash-window handling and health/cancellation contracts.

Unit tests cover transaction-local TOAST, key changes, collision replay, phase
errors, exact timestamps including pre-epoch raw frames, configurable work bounds
and legacy serialization. The native PostgreSQL test assembles a real transaction,
persists it, reopens SQLite, verifies identical redelivery, confirms the durable
head and observes the exact acknowledged slot position. It also compares commit
time with the local clock window. This proves the exercised path, not a complete
source lifecycle or all crash windows.
