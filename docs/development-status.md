# Development status

## Current slice

Canonical SDK values, schemas, immutable committed replay and initial durable
SQLite recording storage are implemented. Storage has passed a fresh independent review.
Verified checkpoints, source-session orchestration and the application are pending.

## Completed evidence

- Local storage implements worker-owned SQLite staging/publication, atomic
  append/progress, indexed pages, duplicate validation, lifecycle and deletion.
  All 17 focused storage/recording tests pass, including actual SQLite exhaustion,
  corruption, concurrency and shutdown regressions. See `docs/local-storage.md`.
- A fresh storage thermonuclear review and two follow-ups verified five fixes:
  baseline completeness, damaged-schema rejection, WAL read concurrency,
  asynchronous errors and consistent schema inspection during initialization.
- The full quality gate passes with 82 unit tests, all five Semgrep fixture groups,
  strict compilation, lint, formatting, architecture and hygiene checks.
- Seven actual native PostgreSQL integration tests passed in the prior slice:
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

| Slice                   | Goal sections           | Required evidence                                                     | State                                                              |
| ----------------------- | ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Foundation              | 2, 4, 5, 10, 11         | Strict build, hooks, architecture fixtures, quality gates, CI         | In progress                                                        |
| Capture proof           | 4.2, 4.4, 6.1, 12.2     | Real PG snapshot/stream overlap, exact scalar decoding                | Handoff proven; full scalar/TOAST coverage pending                 |
| Headless engine/storage | 3.2, 3.4, 4, 5, 8, 12.1 | Conformance, independent replay oracle, checkpoints, streaming import | Initial durable store reviewed; checkpoints/reconstruction pending |
| Capture lifecycle       | 6.1, 9, 12.2            | Doctor/setup/cleanup, crash/ack windows, reconnect, schema boundaries | Pending                                                            |
| CLI/API/browser/query   | 7, 8, 12.3              | Every listed command and journey, SQL isolation, accessibility        | Pending                                                            |
| Integrations            | 6.2, 12.2–3             | Real Prisma, pg and packed custom-source consumers                    | Pending                                                            |
| Release                 | 2, 9, 11–15             | Privacy, full gate, package smoke, benchmarks, docs, visuals, review  | Pending                                                            |

Each slice requires a fresh independent review and fixes before proceeding.
The full section 15 checklist remains authoritative; this map does not narrow it.

## Next steps

1. Connect snapshot/pgoutput primitives to the canonical SDK value/schema/event
   model through public source contracts and the durable SQLite store. Implement
   source orchestration, explicit replay work bounds and verified checkpoint replay.
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
