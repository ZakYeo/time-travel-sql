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

## Portable baseline ingestion: 7 September 2026

A fresh read-only thermonuclear reviewer identified two boundary issues:

- Sixteen canonical rows at their individual byte limit could exceed the public
  batch cap once wrappers were added. The adapter now fetches at most fifteen;
  a native maximal-row regression checks both completeness and encoded batch size.
- Closing during a pending read used internal cancellation but only external
  cancellation received a canonical error. Both now reject with `CANCELLED`, with
  checks after awaited reads and before completion. Native pending/idle close and
  external idle cancellation exercise ownership and retained-slot behavior.

The reviewer verified both fixes and found no remaining actionable blocker.
Bootstrap publication/cleanup ordering, aggregate failure preservation and module
cohesion were reviewed. Parent-run gates and native tests supply execution evidence;
the independent review was static. Full recorder lifecycle remains pending.

## Explicit PostgreSQL setup: 7 September 2026

A fresh read-only thermonuclear reviewer found no structural or SQL-injection
blocker. The plan/apply split is cohesive and canonical input helpers avoid repeated
boundary validation. Review requested stronger mutation-boundary evidence:

- A native lock-wait test now observes blocked DDL through an independent connection,
  cancels setup, and verifies socket closure, unchanged replica identity and no
  publication. Table creation is committed separately from the fixture's lock.
- A bounded fixture proxy discards the actual server COMMIT response and disconnects
  both peers. Read-only inspection recovers the committed receipt through a fresh
  connection; duplicate apply still rejects.

Documentation distinguishes the separate identity/SQL connections, publication
marker and intended slot name from exclusive capture or slot ownership. Guarded
cleanup and durable ownership metadata remain pending. Parent-run gates provide
execution evidence; independent review is read-only.

## Guarded publication cleanup: 7 September 2026

A fresh read-only thermonuclear reviewer found no structural or correctness blocker
in the single-connection identity check, transactional rename and post-lock
OID/marker validation. Native tests exercise replacement and marker races, another
actual cluster with matching object OIDs, non-superuser ownership and lost COMMIT
response retry. Canonical receipt validation bounds interpolated SQL values.

Review required explicit limits on slot-absence checks. Cleanup now checks again
after acquiring the publication lock and a native race covers a slot created during
the wait. Documentation states that arbitrary concurrent slot creation can still
occur before COMMIT; this is not exclusive capture coordination or slot ownership.
Parent-run gates supply execution evidence. Full slot cleanup and durable ownership
remain pending.

## Cooperative capture leases: 7 September 2026

A fresh read-only thermonuclear reviewer found an actual-session identity gap:
the snapshot reader could be independently routed to another cluster while retaining
the exporter's identity. Both sessions now verify cluster/timeline/database before
slot creation. The replication-capable reader requires simple catalog queries;
bounded identifier validation and explicit escape strings support this safely.
Native regressions reject split routing before either cluster has a slot and read
hostile quoted catalog identifiers successfully.

The reviewer verified the fix and found no remaining structural or correctness
blocker in the slice. Session-lock cleanup, health deadlines and lease cancellation
were reviewed. The complete local gate passes with 156 unit tests, and 44 native
PostgreSQL tests pass. Review was static; parent execution supplies test evidence.
Cooperative locks do not prove slot generation ownership or exclude arbitrary SQL.

## Durable capture bindings: 7 September 2026

A fresh read-only thermonuclear reviewer found duplicated version-to-table-count
policy in schema inspection and migration. Both now use one typed count manifest,
which the reviewer verified. Storage documentation now describes version 3 and
retained read-only version-2 reconstruction compatibility.

No remaining actionable blocker was found in immutable transactional attachment,
bounded metadata, cross-recording integrity checks, source/epoch/schema association
or module cohesion. The native test covers reopening persisted metadata, baseline
publication and lease reacquisition with the slot retained; it does not claim full
stream resume or slot generation ownership. Parent-run gates supply execution
evidence; the independent review was static.

## Bound bootstrap orchestration: 7 September 2026

A fresh read-only thermonuclear reviewer found no blocking correctness or structural
issue. Eager and planned sources share staging, publication and cleanup; metadata
and binding persist before source factory invocation. Canonical opened-schema
comparison precedes row reads, and failed creation cannot invalidate an existing
recording. The PostgreSQL plan derives its selection from the lease receipt and
excludes connection options from persisted metadata.

The reviewer requested a clear scope distinction, now recorded in bootstrap docs:
bound bootstrap is implemented; automatic restart recovery and guarded slot cleanup
are still pending. Parent-run checks pass with 169 unit tests and 46 native PostgreSQL
tests. The new native test checks ordering through an independent SQLite connection;
the review itself was static.

## Owned recording sessions: 7 September 2026

A fresh read-only thermonuclear reviewer found two lifecycle races:

- A newly opened PostgreSQL stream can buffer a commit before recorder startup.
  Startup now accepts both active stream states with matching schema/durable head.
  Native resume explicitly waits for retained WAL to be buffered before starting.
- A stop request could mask an already rejected external cancellation. Owned close
  now begins after queued outcomes settle and suppresses cancellation only when
  closing an active source. Terminal status precedes source rejection, and tests
  cover read/ack cancellation as well as a queued terminal cancellation.

The reviewer verified both fixes and found no remaining blocker. Shared lifecycle
ownership, append draining, single close and aggregate errors remain cohesive.
Automatic reconnect and full crash recovery are not established by this slice.
Parent-run tests provide execution evidence; the review was static.

## Durable head restoration: 7 September 2026

A fresh read-only thermonuclear reviewer found no correctness or maintainability
blocker. Reconstructing the predecessor and applying the final commit preserves
the duplicate fingerprint. Canonical metadata/selection/position checks, shared
ordered row paging and exact declared bounds prevent exposing partial or mismatched
state. Session cleanup is memoized and the final metadata check is explicitly an
observation under caller-owned exclusivity, not a replacement for a lock.

Six unit tests cover reconstruction, mutation detection, cancellation and failure
preservation. The native stop/reopen/resume composition now uses the public helper
under its capture lease. Parent-run gates pass with 186 unit tests and 47 PostgreSQL
integration tests; the independent review was static.

## Composed resume: 7 September 2026

A fresh read-only thermonuclear reviewer identified an ownership contract gap:
source lease loss can release advisory locks while a local append is still draining.
A new recorder could otherwise acquire the source lease, restore and start before
the old recorder's append or final lifecycle write. The resume API and documentation
now require exclusive local recording ownership through completion. Actual local
writer fencing is explicitly unfinished and prioritized next; this slice does not
claim safe overlapping or automatic recovery.

The remaining composition is cohesive: acquisition precedes restoration, canonical
identity/binding is rechecked, startup cleanup respects ownership transfer, and
completion waits for lease release while retaining both errors. A shared resumable
recording decoder removes duplicated lifecycle policy. Unit/native execution is
performed by the parent; the independent review was static.

## Durable writer fencing and SQL composition

A fresh read-only thermonuclear review found two cleanup defects: saturated request
queues prevented release, and abandoned active ownership could make invalid history
undeletable. Release now waits for bounded admission; explicit deletion atomically
fences stale handles. The reviewer reproduced both fixes with actual SQLite workers.
Ordered generations, incarnation checks and transactional write enforcement passed
review. Composed tests cover delayed append and activation after replacement startup.

The same review found no blocking issues in the scoped immutable SQL builder for
simple-protocol catalog, snapshot and publication setup queries. It reuses canonical
identifier validation and explicit literal escaping while ordinary parameterized
queries remain intact. Parent-run gates provide execution evidence.

## Recorder process crash barriers

A fresh thermonuclear review found that the test process owner could wait forever
on failed spawn because only exit settled cleanup. It now settles on close, which
also covers startup failure and drained stderr. The fixture stays scoped to its own
child and disposable cluster. Review also distinguished crash restart evidence from
forced duplicate redelivery; documentation preserves that distinction. Native cases
exercise multi-change commits, key updates, deletion and independent SQL comparison
at the before-append, after-append and after-acknowledgement SIGKILL barriers.

## Automatic reconnect and terminal source failures

A fresh thermonuclear review identified acknowledgement errors escaping classification,
codeless pg transport failures being treated as terminal, cancellation replacing
validation during cleanup, and startup disconnects becoming metadata mismatches.
The adapter now retains classified failures through acknowledgement and terminal
status, narrowly normalizes pinned-driver EOF/deadline errors, and preserves
validation/aggregate cleanup failures. Focused unit and native tests cover the fixes.
A follow-up found same-tick stop could suppress independent cancellation; ownership
of startup/backoff cancellation is now explicit and queued failures settle first.

The supervisor's policy/lifecycle split remains cohesive. Each retry uses canonical
SDK resume and waits for ownership cleanup. Native proof includes six transport and
retained-slot scenarios; missing continuity never triggers replacement resources.

## Cleanup assessment and slot ownership boundary

A fresh thermonuclear design review rejected using compatible slot configuration,
published history, publication markers or plausible progress as slot-incarnation
proof. It also identified the unavoidable check/drop gap in a conditional name-based
SQL call. Destructive slot cleanup was not introduced under an unsupported guarantee.

The resulting read-only assessment and shared actual-connection verifier passed
implementation review. Every existing slot requires ownership review; lost WAL and
physical replacement remain inspectable. The shared source verifier preserves
publication cleanup's lock, marker and second-slot-check guards. Review also prompted
updates distinguishing implemented cooperative coordination/local fencing from the
remaining source-slot authority requirement. Native execution supplies the evidence.

## Disposable Docker Compose capture fixture

A fresh read-only thermonuclear review found cleanup scope began after fallible
acquisition, cleanup could short-circuit, client calls lacked explicit deadlines,
and the new Vitest configuration was excluded from typechecking. All are fixed:
resources register cleanup as acquired, every cleanup is attempted with primary
errors retained, calls are bounded, and all Vitest configurations are checked.
The follow-up found no remaining blocking findings in this slice.

Five fake-executable tests exercise unique project scoping, explicit local Docker
selection, rejected endpoints, failed startup/workload and combined teardown errors.
A separate live Compose smoke passed after the final cleanup refactor: PostgreSQL
16.15 captured a commit through public APIs, reconstructed rows matched source SQL,
and the disposable fixture was removed. The broader native suite remains separate.

## Portable recording byte framing

A fresh thermonuclear review found that immediately available async input could
starve timer-delivered cancellation through an uninterrupted microtask chain. The
reviewer reproduced 100,000 encoded records completing before the abort timer ran.
Encoding and decoding now yield to the Node event loop after bounded byte/frame
work; independent timer regressions cover both buffered paths. The follow-up
reproduction stops with `CANCELLED` after 256 chunks.

The review also found the new Node exchange package missing from the browser
adapter exclusion and an overstatement about JSON member ordering. The dependency
rule and documentation are corrected. The final review found no remaining blockers
in physical framing; semantic manifest validation and atomic publication remain
outside this slice. Parent-run gates supply the broader execution evidence.

## Atomic import staging

A fresh thermonuclear review found shared abort listeners could be removed by an
overlapping call, private staging unnecessarily acquired the destination write
lock, worker-owned temporary paths could leak after termination, and complete
baseline scans lacked cancellation checkpoints. The implementation now uses
independent listeners, separate staging transactions, parent-owned exact-directory
cleanup and callbacks through canonical row and commitment scans.

Follow-up review caught a missing callback in the source commitment scan, sealing
before destination COMMIT, and cleanup short-circuiting when worker closure failed.
All are fixed. Staging is sealed only after the destination transaction (including
response validation) succeeds, and cleanup preserves independent failures. The
final review found no remaining blockers in this storage primitive.

Thirteen tests exercise actual worker behavior, rollback after late staged replay
failure, lock independence, existing-ID preservation, offline reconstruction,
worker termination, overlapping cancellation, exact baseline scan interruption,
destination COMMIT failure/retry and cleanup despite worker-close failure. The
semantic manifest and file import/export service remain outside this approval.

## Semantic portable exchange and pinned exports

A fresh thermonuclear review found export verification depended on checkpoint
restoration, coupling authoritative portable data to excluded derived artifacts
and their candidate budget. Export now performs direct HistoryScan/HistoryState
replay through a pinned head. A strengthened regression creates over 1,000 corrupt
checkpoint candidates: the checkpoint path reaches its limit while export/import
of valid authoritative history succeeds.

The review approved canonical manifest/fingerprint validation, ordered baseline
commitments, verified-EOF import publication, immutable export snapshots and the
shared bounded read-worker owner extracted from reconstruction. The final review
found no remaining actionable issues in this milestone, subject to parent-run
gates. Test decomposition separates valid round trips from invalid-input cases;
real file output uses a stream pipeline.

Ten new tests cover actual file/offline reconstruction, source append/deletion
while exporting, exact scalars/Unicode order, semantic and trailer corruption,
cancellation, empty history, duplicate IDs, declared bounds and session capacity.
Context and column-policy provenance, CLI file workflows and full-goal acceptance
remain outside this approval.

## Owned recording files

A fresh thermonuclear review found that nested async iterator closure could hide
an input close failure when decoding had already failed. File input now retains
owned I/O errors outside generator propagation and aggregates them at the public
boundary. Closure remains before verified EOF publication. Regression tests inject
close failures with both valid and malformed real-file input.

Follow-up review found no further blockers in this milestone. Multiple simultaneous
cleanup failures can repeat an error in nested aggregates; diagnostics retain all
failures. Nine tests cover file ownership, exclusive publication races, cancellation,
regular-file bounds and cleanup. Filesystem hard-link support, process-death
temporary remnants and directory-entry durability limits are documented. CLI
composition and the remaining full-goal requirements are outside this approval.

## Recording-management CLI

A fresh thermonuclear review found output errors could emit an uncaught EPIPE
stack, literal `--json` operands changed output mode, read cancellation could
report success, and deadline expiry during cleanup could relabel an earlier
external cancellation. These are fixed with parsed option handling, explicit
stream error ownership, post-cleanup read checks and a retained first abort cause.
The deadline includes configuration I/O, with bounded reads and explicit budget
precedence.

Follow-up review identified unread stdout as an unbounded shutdown wait. Output
now observes cancellation, diagnostic delivery is bounded, and the executable
exits after resource cleanup when Node retains an abandoned native stdio write.
A real 8,000-event transaction test leaves stdout unread, sends SIGINT after data
arrives and proves bounded exit with a stable cancellation diagnostic. Review
found no further actionable issues, subject to required checks. The broader CLI,
browser, SQL and full packaged-application acceptance remain pending.

## Historical investigation and paired states

A fresh thermonuclear review approved the bounded merge comparison, canonical
full-stream validation and paired SQLite snapshot design. Two identified fixes
reject explicit null limits and allow legal before/after field deltas above 4 MiB
within the configured result budget. A follow-up requested a direct large-delta
regression; a 128-column near-limit fixture now proves that case.

Follow-up review found no additional implementation blockers. CLI policy remains
in the SDK, cleanup ownership is shared, and the extracted reconstruction function
lets an actual SQLite test delete the recording between restores to prove snapshot
coherence. Eleven focused tests and the full 316-unit/62-native suites pass. Row
lifecycle, SQL, browser and remaining full-goal requirements remain outside this
milestone's completion evidence.
