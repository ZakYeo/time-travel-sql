# Independent review evidence

## Foundation: 7 September 2026

Two fresh read-only thermonuclear reviewers examined the initial SDK and gates.

- First review: require strict checking of tests/tooling and enforce type-only
  ports, private import boundaries, browser isolation and adapter separation.
  Fixed with a test tsconfig, ESLint AST policy, dependency-cruiser rules and
  executable allowed/forbidden fixtures.
- Second review: excluding node_modules erased installed dependency edges and
  direct browser driver imports were not forbidden. Fixed by retaining edges
  without traversing external packages and declaring a browser runtime allowlist.
  Resolved-package fixtures exercise forbidden pg and permitted Preact imports.
- Neither review found a structural or correctness defect in exact source position
  comparison. Semgrep rules and hook wiring were reviewed; no remaining findings.

Validation: `npm run check` includes strict SDK/test compilation, ESLint,
Prettier, dependency-cruiser, five Semgrep rule fixture groups, 28 unit tests and
secret/module-size checks. This is foundation evidence, not release validation.

## Snapshot handoff: 7 September 2026

A fresh read-only thermonuclear reviewer identified three correctness issues:

- Normalize unsigned xid/OIDs from the transport decoder; fixed with high-bit
  Begin/Relation/Insert protocol fixtures.
- Recheck cancellation after connection shutdown before emitting completion;
  fixed with a real-source regression that aborts during `Client.end`.
- Inspect and stop an owned postmaster after any attempted startup, including a
  reported failure; fixed with a wrapper that starts real Postgres then exits
  unsuccessfully. The test proves the process is gone before its data is deleted.

No module cohesion or size blocker was found. The reviewer distinguished these
implemented primitives from still-pending durable recorder/session features.

## Exact values and replay: 7 September 2026

A fresh read-only thermonuclear reviewer identified three validation issues:

- JSONB needed PostgreSQL-specific decoded-string and numeric validation; fixed
  with real PostgreSQL rejection comparisons while preserving JSON semantics.
- Row and event limits counted UTF-16 units instead of UTF-8 bytes; fixed with
  shared byte accounting, serialization framing and multibyte boundary tests.
- Type modifiers needed semantic validation; fixed in one module that rejects
  invalid modifiers and values that would round, truncate or overflow.

The reviewer verified the fixes, source/epoch identity checks and accessor-free
array decoding, independently reran 29 affected unit tests, and reported no
remaining actionable finding in scope. The immutable replay design was judged
cohesive. Full durable-ingest and product requirements remain outstanding.

## Initial durable storage: 7 September 2026

A fresh read-only thermonuclear reviewer found four issues and an initialization
race during follow-up. All were fixed before committing:

- Persist baseline count and aggregate checksum so missing rows cannot become a
  smaller valid-looking snapshot; verify these during authoritative reconstruction.
- Separate first initialization from version-1 schema validation. Missing tables
  must fail instead of being recreated empty.
- Read the committed WAL snapshot using deferred transactions while writers use
  immediate transactions; a held writer lock must not block existing readers.
- Reject oversized requests asynchronously, preserving the public Promise contract.
- Inspect version and schema in one read transaction before initialization. A
  controlled concurrent WAL interleave verified that both reads share one snapshot.

The reviewer independently verified all fixes and reran all 17 affected tests.
No remaining blocking finding was reported in the implemented slice. Full-head
memory/work accounting, the per-page baseline count scan and checkpoint-based
restart remain explicit follow-up requirements, not completed capabilities.

A final local audit found that SQL `LIKE 'sqlite_%'` also skipped application
objects such as `sqliteXsentinel` because `_` is a wildcard. A failing real-SQLite
regression reproduced the ownership bypass; exact-prefix `GLOB 'sqlite_*'`
matching fixes it.
The reviewer independently verified this fix and all seven integrity regressions.

## Checkpoints and replay bounds: 7 September 2026

A fresh read-only thermonuclear reviewer found two issues and an accounting gap
during follow-up. All were fixed:

- Public checkpoint pages now verify aggregate artifact integrity and the
  authoritative prefix, using the same helpers as restart. Per-row checksums
  alone cannot detect valid rows transplanted from another checkpoint.
- Candidate iteration no longer silently stops after the newest 100 artifacts.
  It can find an older valid checkpoint and reports actual work-budget exhaustion.
- Raw stored payload bytes are charged before checksums and JSON decoding, even
  when a candidate or row is invalid. All attempts share one operation budget.

The reviewer independently reran all 15 focused tests, including a 90-commit
independent model, invalid-candidate accounting, migration, restart fallback and
SQLite-full publication rollback. No further actionable blocker was reported in
the implemented slice; module cohesion was explicitly reviewed. Historical
reconstruction sessions, automatic checkpoint scheduling, timestamp selection
and measured performance remain subsequent work.

## Public reconstruction: 7 September 2026

A fresh read-only thermonuclear reviewer identified two issues, both fixed:

- A synchronous five-second SQLite read lock wait delayed worker cancellation.
  Reconstruction now fails promptly on exclusive locks with no native busy wait.
  An actual exclusive-lock regression bounds failure and owner shutdown.
- The SDK iterator requires stable canonical ordering. The public port now states
  ordering, cursor scope and completion semantics; multi-table tests check resets.

The reviewer independently ran all 15 reconstruction tests and verified the fixes,
SDK iterator ownership/completeness validation and paging above the 20 MiB response
limit. No remaining actionable blocker was reported in this slice. Historical SQL,
source orchestration, timestamp selection and measured performance remain pending.

## PostgreSQL schema/value boundary: 7 September 2026

A fresh read-only thermonuclear reviewer identified redundant scalar validation:
`postgresRow` normalized each value and immediately sent it through the SDK row
decoder again. It now constructs tagged inputs and lets the canonical row decoder
own normalization once. No further structural or correctness blocker was found.
The review confirmed independent column/key order, scoped relation identity and
public package boundaries. Typed driver-owned helpers do not duplicate generic
hostile-object decoding machinery. Parent-run unit and actual PostgreSQL tests
supply execution evidence; the independent review was static. Full source session
and replication lifecycle remain pending.

## Pgoutput row changes: 7 September 2026

A fresh read-only thermonuclear review found no actionable structural or
correctness blocker. Relation checks, tuple extraction and canonical validation
remain cohesive; recorded transaction-local lookup resolves TOAST without source
queries. FULL before-images, stale rows and key changes have explicit handling.

The reviewer required an evidence distinction now documented: relation messages
cannot detect primary-key/nullability-only DDL, and the native TOAST-sized test is
separate from unit coverage of explicit unresolved markers. Catalog enforcement,
transaction assembly/bounds, truncate handling and source ownership remain pending.
Parent-run tests supply execution evidence; this independent review was static.

## PostgreSQL transaction assembly: 7 September 2026

A fresh read-only thermonuclear reviewer found two issues, both fixed:

- The pinned library already adds the PostgreSQL epoch and reads timestamps as
  unsigned. Adding the epoch again introduced a 30-year error. The transport now
  reads signed raw timestamps and converts once; raw positive/pre-epoch protocol
  tests and a native clock-window assertion cover this boundary.
- An empty event array costs two bytes. A one-byte configured budget previously
  escaped checks without any row events. Configuration now requires at least two
  bytes and tests cover empty commits at that boundary.

The reviewer independently ran all seven focused tests and verified the fixes.
No remaining actionable blocker was found. The phase model, bounded lookup overlay
and canonical whole-commit replay were judged cohesive. Native evidence additionally
covers SQLite reopen, exact timestamp persistence, duplicate handling and confirmed
slot progress. Full source lifecycle and crash-window guarantees remain pending.

## PostgreSQL preflight: 7 September 2026

A fresh read-only thermonuclear review initially found no static blocker, but the
native cancellation test exposed a driver startup hang. The reviewer reproduced
it independently: intentional client.end() resolves while connect() remains pending
and its timeout is cleared. The shared startup helper now explicitly settles on
abort; preflight and both exported-snapshot connections use it. The reviewer
independently passed both controlled authentication-stall regressions, including
peer socket closure, and found no remaining actionable blocker.

Review also prompted active-slot and missing schema-USAGE native coverage, and
progress checks reject local positions beyond current source WAL. Slot/publication
predicates remain separate from connection orchestration. Preflight is documented
as a point-in-time primitive, not full identity/ownership/resume enforcement.

## PostgreSQL source identity: 7 September 2026

A fresh read-only thermonuclear reviewer found no actionable code blocker. Exact
uint64 system IDs and uint32 timelines remain strings; snapshot bootstrap and the
standalone replication probe reuse one decoder. A shared owned-client helper
consolidates cancellation, safe errors and cleanup without moving capture policy
into connection plumbing. Native coverage rejects an independent cluster with
matching database/table OIDs, and existing startup cancellation regressions remain.

Review required documentation to distinguish the separate replication and SQL
connections. Routing can mix observations, and point-in-time preflight is not full
ownership or resume proof. The actual capture connection must revalidate identity.
These limits are now explicit. Parent-run full gates provide execution evidence;
the independent review was static.

## PostgreSQL live stream: 7 September 2026

A fresh read-only thermonuclear reviewer found no production correctness or
maintainability blocker. Review prompted precise timeout wording and native tests
for actual-stream startup cancellation, SQLite reopen/redelivery and requested
heartbeats. Follow-up identified that a startup heartbeat reply could satisfy the
test before newer WAL existed. The test now waits for a distinct later reply after
advancing WAL before checking durable-only slot progress.

The SDK append-before-ack operation, single delivery handshake and identity plugin
remain cohesive. Driver buffering is explicitly outside the one-transaction
application bound. Full recorder ownership, lifecycle and memory evidence remain
pending. Parent-run tests provide execution evidence; independent review was static.
