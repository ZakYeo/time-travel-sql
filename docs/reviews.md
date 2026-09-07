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
