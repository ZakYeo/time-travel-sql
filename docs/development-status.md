# Development status

## Current slice

Canonical SDK values, schemas, bounded immutable replay, durable SQLite storage
and verified checkpoints are implemented and independently reviewed. Public
reconstruction sessions and a portable SDK row iterator are implemented; source
orchestration and the application remain pending. PostgreSQL catalog/text rows
now map to canonical SDK schemas/values through a shared adapter boundary.
Pgoutput row changes validate wire relations and resolve TOAST from recorded
transaction-local values. Bounded transaction assembly now validates complete
commits and waits for explicit durable confirmation; full source ownership,
reconnect and crash-window handling remain pending. Read-only PostgreSQL preflight
now validates selected catalog/publication scope and retained-slot continuity,
and probes replication authentication plus exact cluster identity/timeline.
An owned live stream now implements the SDK source port, rechecks actual-session
identity and acknowledges only durable progress. Full recorder orchestration remains
pending.

## Completed evidence

- Owned recording sessions validate the persisted head, append before acknowledging,
  drain accepted writes on stop and persist lifecycle outcomes without discarding
  durable history. Native public composition covers stop/reopen/manual resume with
  retained WAL backlog. Automatic reconnect and crash recovery remain pending. See
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
- The full quality gate passes with 180 unit tests, all five Semgrep fixture groups,
  strict compilation, lint, formatting, architecture and hygiene checks.
- Forty-seven actual native PostgreSQL integration tests pass, including an end-to-end
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
- Native PostgreSQL 16.15 available. Docker socket access denied; use an isolated
  native cluster for integration, plus provide the required Compose harness.
- Personal Zak identity configured; origin points to ZakYeo/time-travel-sql via
  personal SSH alias. Foundation commit `a53967e` was pushed successfully.
  GitHub CLI token invalid, but SSH is usable and does not require changing accounts.

## Acceptance map and implementation sequence

| Slice                   | Goal sections           | Required evidence                                                     | State                                                   |
| ----------------------- | ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| Foundation              | 2, 4, 5, 10, 11         | Strict build, hooks, architecture fixtures, quality gates, CI         | In progress                                             |
| Capture proof           | 4.2, 4.4, 6.1, 12.2     | Real PG snapshot/stream overlap, exact scalar decoding                | Handoff proven; full scalar/TOAST coverage pending      |
| Headless engine/storage | 3.2, 3.4, 4, 5, 8, 12.1 | Conformance, independent replay oracle, checkpoints, streaming import | Checkpoints and reconstruction reviewed; import pending |
| Capture lifecycle       | 6.1, 9, 12.2            | Doctor/setup/cleanup, crash/ack windows, reconnect, schema boundaries | Pending                                                 |
| CLI/API/browser/query   | 7, 8, 12.3              | Every listed command and journey, SQL isolation, accessibility        | Pending                                                 |
| Integrations            | 6.2, 12.2–3             | Real Prisma, pg and packed custom-source consumers                    | Pending                                                 |
| Release                 | 2, 9, 11–15             | Privacy, full gate, package smoke, benchmarks, docs, visuals, review  | Pending                                                 |

Each slice requires a fresh independent review and fixes before proceeding.
The full section 15 checklist remains authoritative; this map does not narrow it.

## Next steps

1. Connect snapshot/pgoutput primitives to the canonical SDK value/schema/event
   model through public source contracts and the durable SQLite store. Implement
   source orchestration and automatic checkpoint scheduling.
   Do not build UI over ad hoc raw events.
2. Extend actual-source fidelity coverage (all scalar types, composite keys,
   unchanged TOAST), stream bounds/acknowledgement/lifecycle and recovery.
3. Finish remaining foundation tools (docs/spelling/unused/duplication checks,
   staged-content checks and broader CI) while adding actual packages.
4. Complete durable headless slice before browser development. The native harness
   lives in `test-support/postgres.ts`; each run creates/stops its own cluster.
   Linux native integration CI is configured but not yet claimed executed.

For this environment, prefix commands with
`PATH=/tmp/tts-toolchain/node_modules/.bin:$PATH` to use the pinned runtime.
Sandboxed Node subprocesses can report EPERM even after child output; validated
Git-based checks require the available escalation path. No checks were bypassed.
