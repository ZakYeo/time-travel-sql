# Development status

## Current slice

Real PostgreSQL snapshot/stream handoff proof validated, with bounded snapshot
staging and exact text pgoutput decoding. The complete durable recorder and
application are still pending.

## Completed evidence

- `npm run test:integration`: six real native PostgreSQL 16.15 tests pass across
  snapshot overlap/exact values/rollback, cancellation including shutdown race,
  oversized rows, failed bootstrap retry and live-process startup-failure cleanup.
- Current `npm run check`: 36 unit tests plus all five Semgrep rule fixture groups,
  strict types, lint, formatting, dependency-cruiser and hygiene pass.
- Third fresh thermonuclear review completed for snapshot primitives; all three
  findings fixed and regression-tested. Protocol limits are in
  `docs/postgres-protocol.md`; no durable capture/reconnect claim yet.
- Architecture resolution now handles public ESM package exports and preserves
  compiled dependency edges without traversing generated output.

- Clean `npm ci`: 178 installed packages, zero reported advisories.
- `npm run check`: strict SDK/test types, ESLint, Prettier, dependency-cruiser,
  five Semgrep fixture groups, 28 unit tests, secret and size checks pass.
- `npm run hooks:install` / `hooks:check`: executable repository hooks configured;
  both commit and push run architecture and Semgrep through the aggregate gate.
- Two independent thermonuclear reviews completed; findings fixed and regression
  fixtures added. See `docs/reviews.md`.
- Disposable native PG 16.15 initialized, started on loopback with `wal_level=logical`,
  queried and cleanly stopped. This proves harness feasibility, not capture.
- CI fast lane configured for Linux/macOS; no CI execution claimed yet.

## Environment evidence

- Initial goal commit: `e565cd6`; original specification unchanged.
- Host Node 22.14.0; selected Node 24.20.0 LTS installed temporarily for validation.
- Native PostgreSQL 16.15 available. Docker socket access denied; use an isolated
  native cluster for integration, plus provide the required Compose harness.
- Personal Zak identity configured; origin points to ZakYeo/time-travel-sql via
  personal SSH alias. Foundation commit `a53967e` was pushed successfully.
  GitHub CLI token invalid, but SSH is usable and does not require changing accounts.

## Acceptance map and implementation sequence

| Slice                   | Goal sections           | Required evidence                                                     | State                                              |
| ----------------------- | ----------------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| Foundation              | 2, 4, 5, 10, 11         | Strict build, hooks, architecture fixtures, quality gates, CI         | In progress                                        |
| Capture proof           | 4.2, 4.4, 6.1, 12.2     | Real PG snapshot/stream overlap, exact scalar decoding                | Handoff proven; full scalar/TOAST coverage pending |
| Headless engine/storage | 3.2, 3.4, 4, 5, 8, 12.1 | Conformance, independent replay oracle, checkpoints, streaming import | Pending                                            |
| Capture lifecycle       | 6.1, 9, 12.2            | Doctor/setup/cleanup, crash/ack windows, reconnect, schema boundaries | Pending                                            |
| CLI/API/browser/query   | 7, 8, 12.3              | Every listed command and journey, SQL isolation, accessibility        | Pending                                            |
| Integrations            | 6.2, 12.2–3             | Real Prisma, pg and packed custom-source consumers                    | Pending                                            |
| Release                 | 2, 9, 11–15             | Privacy, full gate, package smoke, benchmarks, docs, visuals, review  | Pending                                            |

Each slice requires a fresh independent review and fixes before proceeding.
The full section 15 checklist remains authoritative; this map does not narrow it.

## Next steps

1. Build canonical SDK values/schema/events and committed replay with independent
   state-oracle tests; connect snapshot/pgoutput primitives through public source
   contracts and durable SQLite staging. Do not build UI over ad hoc raw events.
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
