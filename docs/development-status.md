# Development status

## Current slice

Canonical SDK values, schemas, bounded immutable replay, durable SQLite storage,
verified checkpoints and historical reconstruction are implemented and reviewed.
PostgreSQL capture now includes exact snapshot/stream handoff, durable recording
sessions, local writer fencing, retained-resource resume, bounded reconnect and
native process-crash evidence. Full source-resource cleanup remains incomplete.
Core portable stream import/export and initial recording-management CLI commands
are proven offline. Broader CLI composition, automatic
checkpoint scheduling, historical SQL CLI integration and total-memory containment,
invariants, browser workflows and the remaining acceptance requirements are pending.

## Completed evidence

- The disposable PGlite library adapter now loads validated reconstruction views,
  binds exact values, builds recorded types/modifiers/primary keys through a shared
  SQL builder, derives unavailable-column grants and enforces read-only execution.
  Parent deadlines, result limits, cancellation, teardown-failure retention and
  poisoned-instance rejection are implemented. Tests cover all capture types,
  composite keys, actual committed SQLite selections and unchanged authoritative
  export bytes. CLI composition and hard total-memory containment remain pending.
  The full gate passes 323 unit and 15 query-policy/adapter tests; 62 native
  PostgreSQL tests pass. An isolated offline tarball install executes an exact
  numeric query. See `docs/historical-sql.md`.

- A fifth PGlite policy test proves column-level grants deny unavailable-column
  reads, including aggregates and whole-row
  access, while available-column queries and COUNT(\*) remain usable. The library adapter now derives
  those grants from reconstructed states. See
  `docs/historical-query-policy.md`.

- The SDK now owns historical query request/result contracts and incremental,
  fail-closed result accounting. Five new tests cover exact values, ordinal duplicate
  names, UTF-8/JSON budgets, invalid inputs and oversized wide rows. Actual PGlite
  output uses the same buffer in the policy fixture. The full gate passes 321 unit
  and four query-policy tests. Production execution remains pending. See
  `docs/historical-query-policy.md`.

- Four pinned PGlite policy tests now run in the mandatory check/hook gate. They
  expose username-only privilege reset, exercise compound grammar/permission/
  read-only enforcement, preserve selected exact values, load offline and terminate
  active WASM work while the parent remains responsive. The production query
  adapter and complete resource/type boundaries remain pending. See
  `docs/historical-query-policy.md`.

- Historical row inspection and net state comparison now consume canonical
  reconstruction views through the SDK and CLI. Paired states use one SQLite
  snapshot; eleven tests cover coherent deletion races, exact fields, limits,
  filtering/truncation validation and cancellation. Native PostgreSQL tests pass
  after the shared worker protocol change. See `docs/investigation.md`.

- Recording-management CLI composition now covers init/list/inspect/validate/
  rename/remove/import/export/transaction, explicit configuration precedence,
  JSON diagnostics and cancellation-aware output. Seven process/library cases
  include unread output shutdown. An isolated offline tarball install runs its
  executable. Broader CLI/application commands remain pending. See `docs/cli.md`.

- Owned file helpers now publish completed exports exclusively and import bounded
  regular files with closure before publication. Nine tests cover real offline
  round trips, competing destinations, cancellation and cleanup failures. CLI
  command composition remains pending. See `docs/portable-recordings.md`.

- Semantic portable streams now round-trip a real file through public APIs into
  a fresh offline store. Manifest/fingerprint, baseline commitment, order and head
  checks precede atomic publication. Pinned read-only exports survive source
  mutation and ignore corrupted derived checkpoints. Context/policy provenance
  and CLI file workflows remain pending. See `docs/portable-recordings.md`.

- Private import staging now validates authoritative history and publishes it in
  one destination transaction, preserving existing IDs and rolling back late replay
  failures. Parent-owned cleanup survives worker termination; shared cancellation
  reaches baseline scans. The semantic stream service now uses this primitive. See
  `docs/import-staging.md`.

- Portable byte framing now has a versioned UTF-8 JSONL contract, SHA-256 trailer,
  bounded parsing and cooperative cancellation for buffered input. Independent
  wire fixtures exercise corruption, framing and work limits. Semantic manifests and atomic import are now integrated; context/policy
  provenance and CLI file workflows remain pending. See
  `docs/recording-framing.md`.

- The pinned PostgreSQL 16.15 Docker Compose fixture passes a live public-API
  capture/reconstruction smoke test. Each invocation owns a fresh project, a
  loopback port and teardown; five harness tests cover isolation and failures.
  See `docs/postgres-compose.md`.

- Read-only cleanup assessment now reports publication ownership observations,
  active/incompatible/lost-WAL slots and exact WAL byte distances. Every existing
  slot requires ownership review; no deletion authority is inferred from a binding
  or LSN range. Stock PostgreSQL's missing atomic incarnation check/drop remains an
  explicit unresolved cleanup requirement. See `docs/cleanup-assessment.md`.

- Automatic PostgreSQL resume now retries explicit source availability failures
  with a bounded lifetime budget and capped backoff, after full attempt cleanup.
  Six native transport/recovery cases cover backend and lease loss, socket closure,
  acknowledgement failure, startup timeout and missing-slot rejection. See
  `docs/postgres-reconnect.md`.

- Three native SIGKILL cases now cover termination before append, after durable
  append/before acknowledgement, and after source acknowledgement. Reopening and
  resuming retained resources preserves complete multi-change commits and matches
  independent source SQL across a downtime commit. See `docs/crash-recovery.md`.

- Resume composition now owns source acquisition, durable-head restoration, retained
  stream startup and cleanup through completion. PostgreSQL cancellation and a
  second resume are exercised natively. Durable local writer generations now fence stale appends and lifecycle writes,
  including delayed activation and append during takeover.
  See `docs/resuming-recordings.md`.

- Durable head restoration now uses the public reconstruction contract, applies the
  final recorded commit to preserve idempotence, and rejects metadata changes during
  restoration. It owns cancellation/cleanup and is used by native retained-WAL resume.
  See `docs/restoring-recording-head.md`.

- Owned recording sessions validate the persisted head, append before acknowledging,
  drain accepted writes on stop and persist lifecycle outcomes without discarding
  durable history. Native public composition covers stop/reopen/manual resume with
  retained WAL backlog. Automatic reconnect and process crash windows now have native evidence. See
  `docs/recording-sessions.md`.

- Bound bootstrap now persists local metadata and adapter binding before opening
  the source. A PostgreSQL capture plan derives selection from its lease; native
  evidence observes the persisted binding before slot creation. Failed creation,
  binding, open or schema checks cannot publish a partial baseline. See `docs/bootstrap.md`.

- Immutable capture bindings persist adapter restart metadata before baseline
  publication. SQLite v3 migrates prior stores and retains read-only v2 reconstruction.
  PostgreSQL receipt decoding ties recovered metadata to source/epoch/schema without
  storing connection credentials. See `docs/capture-bindings.md`.

- Cooperative capture leases now coordinate adapter setup/cleanup and leased
  baseline/stream lifetimes. Health failure cancels capture; actual snapshot reader
  and exporter identity checks reject split routing before slot creation. Native
  contention, network-stall, backend-loss and hostile-identifier tests pass. Durable
  slot ownership and full orchestration remain pending. See `docs/capture-leases.md`.

- Publication cleanup verifies actual-connection cluster identity, canonical
  receipt, name/OID and ownership under a transactional object lock. Native races
  cover marker changes, replacement objects, newly appearing slots and lost commit
  responses. Slot ownership/deletion remain pending. See
  `docs/publication-cleanup.md`.

- Setup now generates inspectable SQL, applies selected-table/publication changes
  atomically and recovers matching ownership receipts after uncertain commit
  delivery. Native tests cover a non-superuser owner, inheritance exclusion,
  rollback, name conflicts, lock-wait cancellation and a discarded COMMIT response.
  Guarded resource cleanup and persisted ownership remain pending. See
  `docs/postgres-setup.md`.

- Portable baseline ingestion now stages canonical bounded batches and publishes
  only after successful source completion/close. The PostgreSQL baseline adapter
  shares the snapshot primitive and exposes exact source identity. Native handoff,
  pending/idle cancellation and near-limit row tests pass. See `docs/bootstrap.md`.

- Live delivery holds one complete transaction until durable acknowledgement.
  SDK orchestration appends before acknowledging. Native tests cover SQLite reopen,
  manual reconnect/redelivery, requested heartbeats, timeout and cancellation of
  actual stream startup. See `docs/postgres-stream.md` for limits and remaining work.

- Cluster/timeline checks reject a different real PostgreSQL cluster even when
  database and table OIDs match. Snapshot bootstrap shares the identity decoder.
  Preflight remains a point-in-time check requiring actual-session revalidation.

- Read-only preflight validates permissions, publication scope and retained-slot
  progress. Native tests cover failures and no resource creation. Shared startup
  cancellation now explicitly settles driver connection attempts; independent
  stalled-authentication tests verify peer socket closure. See `docs/postgres-preflight.md`.

- Transaction assembly preserves exact commit time, validates whole-commit replay
  and advances only after durable confirmation. Seven focused tests and the native
  SQLite reopen/duplicate/slot-ack path pass. See `docs/postgres-transactions.md`.

- Pgoutput row changes pass focused validation for relation drift, stale history,
  TOAST and key changes. A real native transaction exercises repeated changes to
  externally stored text against recorded transaction-local rows.

- PostgreSQL schema mapping preserves composite index order independently of
  column order and shares one built-in type map with inspection. Real persisted
  reconstruction covers all 14 supported types. See `docs/postgres-normalization.md`.

- Fifteen reconstruction tests cover stable selected sessions, bounded paging,
  ownership/cancellation, lock failure and portable iteration. A fresh review
  verified fixes for native lock waits and the paging contract. See
  `docs/reconstruction.md`.

- Fifteen focused checkpoint/selection/replay-budget tests pass, including an
  independent 90-commit model, checkpoint suffix equivalence, restart fallback,
  migration, corrupt data, candidate exhaustion and SQLite-full publication.
- A fresh checkpoint thermonuclear review and follow-ups verified aggregate public
  reads, complete candidate search and pre-decode shared byte accounting. No
  remaining actionable blocker in that slice. See `docs/checkpoints.md`.

- Local storage implements worker-owned SQLite staging/publication, atomic
  append/progress, indexed pages, duplicate validation, lifecycle and deletion.
  All 18 focused storage/recording tests pass, including actual SQLite exhaustion,
  corruption, concurrency and shutdown regressions. See `docs/local-storage.md`.
- A fresh storage thermonuclear review and two follow-ups verified five fixes:
  baseline completeness, damaged-schema rejection, WAL read concurrency,
  asynchronous errors and consistent schema inspection during initialization.
- The full quality gate passes with 316 unit tests, all five Semgrep fixture groups,
  strict compilation, lint, formatting, architecture and hygiene checks.
- Sixty-two actual native PostgreSQL integration tests pass, including an end-to-end
  exact snapshot persisted through the SDK/SQLite/reconstruction APIs:
  snapshot handoff, shutdown cancellation, oversized rows, failed bootstrap retry,
  startup cleanup and scalar fidelity against PostgreSQL.
- SDK replay matches an independent seeded model at 300 committed boundaries;
  tests cover key changes, atomic failure, duplicates and source/epoch mismatch.
- Executable commit and push hooks enforce strict types, lint, formatting,
  dependency-cruiser, Semgrep with violation fixtures, unit tests and hygiene.
- Fresh reviews and fixes for the foundation, snapshot and SDK milestones are
  recorded in `docs/reviews.md`. CI is configured, not claimed executed.

## Environment evidence

- Initial goal commit: `e565cd6`; original specification unchanged.
- Host Node 22.14.0; selected Node 24.20.0 LTS installed temporarily for validation.
- Native PostgreSQL 16.15 is available and the broader native suite passes.
  Docker Compose also passes with authorized integration execution permissions;
  the initial socket denial applied to the restricted command context.
- Personal Zak identity configured; origin points to ZakYeo/time-travel-sql via
  personal SSH alias. Foundation commit `a53967e` was pushed successfully.
  GitHub CLI token invalid, but SSH is usable and does not require changing accounts.

## Acceptance map and implementation sequence

| Slice                   | Goal sections           | Required evidence                                                     | State                                                   |
| ----------------------- | ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| Foundation              | 2, 4, 5, 10, 11         | Strict build, hooks, architecture fixtures, quality gates, CI         | In progress                                             |
| Capture proof           | 4.2, 4.4, 6.1, 12.2     | Real PG snapshot/stream overlap, exact scalar decoding                | Handoff proven; full scalar/TOAST coverage pending      |
| Headless engine/storage | 3.2, 3.4, 4, 5, 8, 12.1 | Conformance, independent replay oracle, checkpoints, streaming import | Core portable round trip proven; conformance incomplete |
| Capture lifecycle       | 6.1, 9, 12.2            | Doctor/setup/cleanup, crash/ack windows, reconnect, schema boundaries | Pending                                                 |
| CLI/API/browser/query   | 7, 8, 12.3              | Every listed command and journey, SQL isolation, accessibility        | Pending                                                 |
| Integrations            | 6.2, 12.2–3             | Real Prisma, pg and packed custom-source consumers                    | Pending                                                 |
| Release                 | 2, 9, 11–15             | Privacy, full gate, package smoke, benchmarks, docs, visuals, review  | Pending                                                 |

Each slice requires a fresh independent review and fixes before proceeding.
The full section 15 checklist remains authoritative; this map does not narrow it.

## Next steps

1. Integrate portable streams with CLI file workflows and implement historical SQL
   and application work. Guarded slot cleanup
   still requires a supported atomic ownership boundary; read-only assessment does
   not claim that requirement is finished.
1. Connect snapshot/pgoutput primitives to the canonical SDK value/schema/event
   model through public source contracts and the durable SQLite store. Implement
   source orchestration and automatic checkpoint scheduling.
   Do not build UI over ad hoc raw events.
1. Extend actual-source fidelity coverage (all scalar types, composite keys,
   unchanged TOAST), stream bounds/acknowledgement/lifecycle and recovery.
1. Finish remaining foundation tools (docs/spelling/unused/duplication checks,
   staged-content checks and broader CI) while adding actual packages.
1. Complete durable headless slice before browser development. The native harness
   lives in `test-support/postgres.ts`; each run creates/stops its own cluster.
   Linux native integration CI is configured but not yet claimed executed.

For this environment, prefix commands with
`PATH=/tmp/tts-toolchain/node_modules/.bin:$PATH` to use the pinned runtime.
Sandboxed Node subprocesses can report EPERM even after child output; validated
Git-based checks require the available escalation path. No checks were bypassed.
