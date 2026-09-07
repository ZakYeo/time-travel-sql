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
