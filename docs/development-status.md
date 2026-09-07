# Development status

## Current slice

Initial foundation validated: quality hooks, dependency boundaries, acceptance
mapping and exact source-position contracts. No complete product capability yet.

## Completed evidence

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
  personal SSH alias. Remote read succeeds (empty repository). GitHub CLI token
  invalid, but SSH is usable and does not require changing accounts.

## Acceptance map and implementation sequence

| Slice                   | Goal sections           | Required evidence                                                     | State       |
| ----------------------- | ----------------------- | --------------------------------------------------------------------- | ----------- |
| Foundation              | 2, 4, 5, 10, 11         | Strict build, hooks, architecture fixtures, quality gates, CI         | In progress |
| Capture proof           | 4.2, 4.4, 6.1, 12.2     | Real PG snapshot/stream overlap, exact scalar decoding                | Pending     |
| Headless engine/storage | 3.2, 3.4, 4, 5, 8, 12.1 | Conformance, independent replay oracle, checkpoints, streaming import | Pending     |
| Capture lifecycle       | 6.1, 9, 12.2            | Doctor/setup/cleanup, crash/ack windows, reconnect, schema boundaries | Pending     |
| CLI/API/browser/query   | 7, 8, 12.3              | Every listed command and journey, SQL isolation, accessibility        | Pending     |
| Integrations            | 6.2, 12.2–3             | Real Prisma, pg and packed custom-source consumers                    | Pending     |
| Release                 | 2, 9, 11–15             | Privacy, full gate, package smoke, benchmarks, docs, visuals, review  | Pending     |

Each slice requires a fresh independent review and fixes before proceeding.
The full section 15 checklist remains authoritative; this map does not narrow it.

## Next steps

1. Commit/push validated foundation with personal identity and hooks enabled.
2. Prove exact-value decoding and real exported-snapshot handoff early. Native PG
   binaries are under `/usr/lib/postgresql/16/bin`. A disposable capability-check
   cluster at `/tmp/tts-pg-proof` is stopped; build a unique owned test harness.
3. Finish remaining foundation tools (docs/spelling/unused/duplication checks,
   staged-content checks and broader CI) while adding actual packages.
4. Complete durable headless slice before browser development.

For this environment, prefix commands with
`PATH=/tmp/tts-toolchain/node_modules/.bin:$PATH` to use the pinned runtime.
Sandboxed Node subprocesses can report EPERM even after child output; validated
Git-based checks require the available escalation path. No checks were bypassed.
