# /goal — Build Time Travel SQL

Build **Time Travel SQL** in `/home/zak/personal/time-travel-sql`: a complete,
lightweight, modular, open-source database history debugger for existing
PostgreSQL applications, with a reusable TypeScript SDK, a local CLI and browser
application, durable recordings, historical SQL inspection, and a tested Prisma
integration example.

Work autonomously through implementation, validation, usability review, fixes,
documentation, and release packaging. This is an extensive implementation goal,
not a request for a plan, scaffold, proof of concept, demo-only application, or
unfinished MVP. Deliver a finished first release within the explicit supported
scope below. A focused support matrix is acceptable; incomplete behaviour inside
that matrix is not. The completion checklist defines the finish line, rather
than an arbitrary number of iterations or an open-ended feature backlog.

Do not ask the user for API keys, cloud accounts, product-design decisions, or
routine implementation approvals. No hosted service or AI provider is necessary.
Make reasonable decisions, record material tradeoffs, and keep working. Preserve
this file and its initial commit as the original goal specification. Do not
weaken the requirements to match an easier implementation.

## 1. Product purpose and audience

Help a developer answer:

> This row is wrong. What changed it, what else changed in that transaction, and
> what did the recorded database look like immediately before and after it?

The central experience is selecting a recording, navigating committed
transactions, examining exact row and field diffs, querying a historical state,
and locating the first recorded violation of an invariant. Users can export a
portable recording and investigate it without reconnecting to the source.

Serve three audiences through the same engine:

- Application developers who want a local debugger beside an existing Postgres
  application, including applications using Prisma, Drizzle, other ORMs, or SQL.
- Library and ORM maintainers who want small, documented public integration
  contracts without adopting this project's UI, storage implementation, or CLI.
- Engineering teams who want reproducible development/test recordings, headless
  inspection, failure artifacts in CI, and offline sharing inside their systems.

The product records database outcomes. Application context is an optional
enrichment. It does not require replacing Postgres, adopting a workflow framework,
rewriting application queries, or using a particular ORM.

Use **Time Travel SQL** as the product name and `time-travel-sql` as the intended
CLI name. Package names are provisional until availability is checked; do not
claim registry ownership or publication. A sample application is an onboarding
asset, not the whole product.

## 2. Language, dependencies, and distribution decisions

Use strict TypeScript and ESM for the initial implementation. This provides an
accessible JavaScript integration surface and avoids a Rust compiler, native
addon, or platform-specific binary becoming a prerequisite for ordinary users.
Rust is compatible with a future process, WASM, or native adapter boundary, but
adding it now requires measured evidence that TypeScript cannot meet a concrete
requirement. Do not build a second engine or speculative FFI layer.

Choose and pin a currently supported Node.js LTS baseline after checking actual
tool compatibility. Record the supported Node, Postgres, browser, and Prisma
versions. Commit one package-manager lockfile; prefer npm workspaces. Use a small
number of real package boundaries, not a workspace framework or build platform.

Dependency policy:

- The SDK's domain, ports, and deterministic engine should have zero production
  dependencies and no Node, browser, database-driver, or ORM imports.
- Put Postgres drivers/decoders, durable storage, embedded SQL execution, browser
  rendering, and optional integrations behind separate import/package boundaries.
  Installing or importing the SDK must not pull in a browser app, Prisma engine,
  PostgreSQL WASM binary, or native database binding.
- Prefer a maintained Postgres transport/replication library over writing TLS,
  authentication, or the complete wire protocol. Minimise dependencies without
  inventing infrastructure that another small, appropriate library already owns.
- Prefer Node's supported built-in SQLite facility for indexed recording storage
  if the chosen LTS supports the required behaviour. Otherwise justify a mature
  storage dependency. Do not implement a homemade crash-safe database to save one
  dependency. Keep blocking storage work away from interactive runtime threads.
- Prefer PGlite, isolated behind an embedded-query adapter, for credential-free
  historical SQL execution. Verify its actual compatibility and lifecycle. Load
  it only where historical SQL is needed. Its runtime assets must be installed
  locally and work without a CDN or first-query network download.
- PGlite is not proof of compatibility with Postgres logical replication. Test
  live capture against actual Postgres separately.
- Use Vite and a small UI approach such as Preact or focused TypeScript components.
  Choose one based on clarity. Avoid large component kits, global state frameworks,
  heavyweight editors, and chart libraries unless a specific interaction requires
  them. Do not trade maintainable rendering for a bespoke UI framework.
- Keep Prisma and a second integration's dependencies in their optional packages
  or examples. Development tools do not belong in runtime dependency counts.
- Record each direct production dependency, purpose, licence, alternatives, and
  which package imports it in a short dependency decision document. Measure the
  actual transitive/install cost. Do not use a dependency count as a substitute
  for maintainability, correctness, or supply-chain clarity.

Produce usable npm package tarballs locally, with correct exports, type
declarations, included runtime assets, licences, and a working executable. A
consumer must not need this monorepo, its test tools, or a TypeScript runtime to
run the packaged application. No Rust compilation should be required.

## 3. Explicit first-release scope

Finish all of these capabilities:

1. A fully functional local recording browser and CLI with a bundled, realistic
   sample recording and no credentials required for first use.
2. A headless SDK capable of validating, ingesting, storing through ports,
   inspecting, diffing, and reconstructing recorded committed states.
3. A real PostgreSQL capture adapter using logical decoding, including a
   consistent initial snapshot, transaction boundaries, durable progress,
   reconnection, and supported schema/type validation.
4. Durable indexed recording storage, reopening after restart, checkpoints, and
   validated portable export/import.
5. Table and row history, transaction detail, state comparison, historical SQL,
   and a bounded chronological invariant scan.
6. A running Prisma/Postgres example and a plain SQL/`pg` example that use the
   same recorder. Include an optional, small, tested transaction-context bridge.
7. A documented custom-source integration using only public SDK contracts and
   shared adapter conformance tests.
8. Automated unit, contract, real database integration, process, browser E2E,
   failure-recovery, package smoke, and performance checks, plus working CI.
9. Open-source-grade installation, usage, support, integration, contribution,
   security, architecture, compatibility, and release documentation.

Support one precisely pinned/tested Postgres major initially, ordinary permanent
tables, explicit table selection, stable primary keys including composite keys,
and the documented built-in scalar types below. Support insert, update, delete,
multi-table transactions, repeated updates within one transaction, key changes,
rollback, savepoint rollback, and reconnection without duplicate publication.
Implement selected-table `TRUNCATE` correctly or detect it and terminate the
usable capture range before it; make that distinction explicit in the matrix.

First-release boundaries:

- A recording epoch has a fixed supported schema. Supply an explicit stop,
  migrate, and start-new-epoch workflow. Do not pretend arbitrary DDL can be
  replayed from row changes.
- Target local development, testing, and trusted internal analysis. Deliver good
  integration seams for enterprise workflows; do not build SaaS tenancy, billing,
  enterprise SSO, or an internet-facing multi-user service.
- No production rollback button, automatic source repair, production backup
  guarantee, or application-code replay. Historical inspection operates on a
  separate reconstructed state, never by rewinding the original database.
- No MySQL, SQL Server, SQLite-source, distributed-database, or every-ORM adapter
  collection. Extensibility is proven with a real custom-source example and
  clean contracts, not empty adapter stubs.
- No claim to capture SELECT results, failed statements, application variables,
  external HTTP responses, original SQL text, source-code locations, or a causal
  explanation unless a separate implemented integration actually recorded them.
- No unsupported replication modes, custom types, extensions, partition layouts,
  generated-expression replay, or two-phase transactions silently treated as
  supported. Preflight, diagnose, and bound the supported path explicitly.

These are product boundaries, not permission to leave promised controls inert or
to describe a partially implemented supported path as finished.

## 4. Correctness contract: establish before building the UI

Write `docs/correctness.md` and executable tests for these invariants. This is
the most important part of the product. No amount of UI polish compensates for
invented history or incorrectly reconstructed data.

### 4.1 Identity, ordering, and capture coverage

- Identify the source, recording epoch, schema revision, relation, transaction,
  and event separately. A table name or transaction ID alone is not a permanent
  identity. Include the source identity needed to reject a different/recreated
  database or incompatible replication slot on resume.
- Use the source's committed order and durable source positions. Do not sort
  transactions by application timestamps, transaction-start timestamps, IDs, or
  the wall clock of the recorder. Keep display timestamps separate from ordering.
- Preserve intra-transaction event order. A committed-state timeline steps across
  whole transactions. Intermediate row events may be inspected as transaction
  detail but must not be labelled externally committed states.
- Clearly define before/after selection, initial snapshot selection, inclusive
  transaction boundaries, and timestamp-to-position resolution. Timestamps can
  tie or move backwards; positions are authoritative and ambiguity is visible.
- Atomically publish all changes in a committed transaction with its durable
  progress. Aborted work must never appear as committed history.
- Represent capture lifecycle and coverage explicitly: bootstrapping, recording,
  paused/stopped, interrupted, and invalid/incomplete ranges. Never silently
  bridge a missing stream segment or show current data as a historical answer.

### 4.2 Snapshot and live stream handoff

- Establish a consistent multi-table snapshot coordinated with the replication
  slot's exported snapshot/source position. Document the actual protocol and
  connection lifetimes; verify there is neither a gap nor double application
  when writes commit during snapshotting.
- Stream snapshot rows in bounded batches. Stage initial state and publish it
  only when schema, rows, and the handoff boundary are all durable and validated.
- A cancelled, crashed, or failed bootstrap must leave an explicitly incomplete
  artifact that can be cleaned up or restarted, not a valid-looking recording.
- Define reconnect and bootstrap retry semantics. Detect missing WAL, dropped
  slots, lost ownership, changed source identity, and corrupted local progress.
  Never invent continuity by creating a replacement slot automatically.

### 4.3 Durable ingest and replay

- Design for at-least-once delivery with idempotent durable application. A replayed
  source transaction cannot duplicate visible history or materialised state.
- Acknowledge a replication position only after the corresponding committed data
  and checkpoint/progress are durable. Test crash windows both before and after
  persistence and acknowledgement. Received, flushed, and applied positions must
  have documented meanings.
- Bound buffering and support backpressure. Large transactions need bounded
  staging/spill or an explicit limit failure before publication; they must not
  exhaust memory or be partially published.
- Restart from the last valid checkpoint and replay the required suffix. A
  checkpoint is an optimisation with a verified source position and schema
  identity, not an alternate source of truth.
- Reconstruct through recorded row values, not by rerunning original mutation SQL.
  Defaults, clocks, sequences, random values, triggers, and external side effects
  must not execute again while reconstructing historical state.
- Replaying from the initial snapshot and replaying from any valid checkpoint
  must produce equivalent logical state. Missing predecessors, invalid updates,
  incompatible schema, and unexpected row identities are errors, not upserts.
- Keep authoritative recording data separate from disposable query workspaces.
  Querying or exploring a past state must not mutate a recording or its source.

### 4.4 Values and schema

- Use a canonical, versioned, lossless value encoding. Distinguish SQL NULL,
  missing/unchanged data, an empty string, JSON null, and redacted/unavailable data.
- Preserve int8 and numeric/decimal values without routing them through JavaScript
  `number`. Preserve timestamp precision and timestamp-with/without-timezone
  semantics without a lossy conversion through `Date`.
- Initially cover and test booleans, signed integer widths, numeric/decimal,
  text/varchar, UUID, date, timestamp, timestamptz, JSON/JSONB, and bytea. Document
  bounds and reject unimplemented special values/type modifiers honestly. JSON
  numbers also require lossless handling; do not lose precision while parsing
  JSONB or rendering JSON cells. Arrays, enums, and custom types may be explicitly
  unsupported until implemented end to end.
- Preserve byte values exactly and escape control characters in human output.
  A truncated display must retain an explicit expansion/export path to the full
  permitted value; truncation is not silent data loss.
- Keep key encoding collision-free, schema-qualified, typed, and order-stable.
  Support composite keys and record a key-changing update's before/after identity.
- Handle replication identity and unchanged TOAST values correctly. Require
  suitable replica identity where needed and explain its source-side cost.
  An unchanged marker is not NULL or an empty value. Never fill a historical
  value by querying the current source row.
- Save sufficient schema metadata to reconstruct supported types and names.
  Quote identifiers safely; never interpolate user-controlled identifiers as
  unquoted SQL. Do not import source triggers, functions, or arbitrary executable
  DDL into a reconstruction workspace.
- Validate schema compatibility at bootstrap and during capture. Relation-message
  validation alone cannot guarantee detection of all DDL. Document the enforced
  migration protocol and detection limits. Stop/mark a boundary on observed
  incompatible changes; do not claim seamless schema evolution.
- Record the captured table set and column policy. A filtered recording is exact
  only for its recorded projection. Do not suggest that unrecorded tables,
  sequence state, grants, or application read snapshots are preserved.

### 4.5 Invariant investigation

Support a saved SQL check whose returned rows represent violations. A scan can
evaluate the check after each committed transaction in a selected range and
return the first recorded failing boundary, its predecessor, violating rows, and
the associated transaction diff. Also handle failure in the starting snapshot.

An invariant may fail, recover, and fail again. Scan chronologically with bounded
work/cancellation; do not use binary search without a proven monotonic predicate.
Report the scan range, progress, timeout, incomplete coverage, and result limits.
Describe a finding as the first observed violation, not proof of the underlying
business cause. The scan must actually evaluate reconstructed states, not return
a fixture annotation.

## 5. Ports, adapters, and package shape

Use ports and adapters with explicit ownership, constructor/factory injection,
small modules, and no dependency-injection container or global service locator.
Use a structure along these lines; adjust physical package boundaries only where
that improves real dependency isolation:

```text
packages/
  sdk/src/
    domain/             # identities, values, events, pure state/diff policy
    ports/              # application-owned dependency contracts only
    application/        # ingestion, inspection, reconstruction use cases
  storage-local/src/    # indexed durable recording implementation
  source-postgres/src/  # snapshot, replication, normalisation, lifecycle
  query-local/src/      # isolated embedded historical SQL implementation
  integration-prisma/  # optional transaction-context bridge and public types
apps/
  cli/src/              # commands, config, composition, local server lifecycle
  web/src/              # views, styles, HTTP client, accessibility
examples/
  prisma-checkout/
  pg-checkout/
  custom-source/
test-support/           # focused conformance, process, and scenario helpers
test/                   # cross-package, process, browser, recovery, packaging
docs/                   # user guides, integration, correctness, decisions
scripts/                # small development/release helpers
.githooks/
.github/workflows/
```

Do not create empty directories or packages to satisfy this drawing. Mocks belong
in test support or explicit sample composition, not in the domain. Implement
public import boundaries before examples begin relying on private paths.

Enforce this dependency direction automatically:

- `domain` depends only on domain modules and language primitives.
- `ports` depends on domain types and other port types; it contains no factories,
  parsers, executable policy, or concrete provider configuration.
- `application` depends on domain, ports, and application-local code.
- Adapters depend on the public contracts they implement and their own focused
  implementation modules. They do not import CLI, UI, or orchestration internals.
- CLI/server composition selects and owns concrete adapters. Browser code uses
  explicit browser-safe contracts and never imports Node or database code.
- The SDK does not import adapters or integration packages, directly or through
  a barrel file. Production modules do not import test helpers or examples.
- No cycles, package-private deep imports, framework leakage, or duplicated
  domain/transport types with drifting semantics.

Design the smallest useful ports for:

- A source session providing schema, consistent baseline, ordered transactions,
  progress acknowledgement, health, cancellation, and explicit close ownership.
- Durable history append/staging, indexed reads, checkpoint publication, and
  recording lifecycle. Do not assume every future adapter has SQLite semantics.
- Historical state reconstruction and isolated SQL execution, with authoritative
  selected-position metadata and bounded results.
- Import/export streams, clocks, IDs, diagnostics, and scheduling where actual
  external effects require injection.

Avoid one enormous repository interface. Split commands, reads, source sessions,
and query workspaces when they have distinct lifecycles and consumers. Conversely,
do not add one-line forwarding services or an interface for every pure function.

Registries should be explicit, typed, and local to composition. No runtime plugin
marketplace, downloaded executable plugins, reflection-based registration, or
generic capability framework. Show how an integrator supplies an implementation
through a factory/options object and runs the same conformance suite.

Define canonical runtime decoders for external config, adapter events, persisted
records, transport DTOs, and imports. Treat input as `unknown`, validate before
domain construction, reject duplicate identities/keys, and bound nested data.
Do not repeat validation/defaulting policy in routes, UI, and adapters.

Public errors need stable codes, safe messages, and useful diagnostic causes.
Never convert an unexpected exception into an empty successful recording. Human
boundaries catch final failures and provide recovery guidance; low-level code
preserves the actual failure. Cleanup failures remain secondary and observable.

## 6. Real Postgres capture and ORM integration

### 6.1 PostgreSQL adapter

Implement real logical decoding against stock Postgres, preferably `pgoutput`
with a deliberately selected protocol mode. Verify library behaviour against
official Postgres documentation and integration tests. Keep connection transport,
protocol translation, relation/type metadata, snapshot import, transaction
assembly, and reconnect policy in focused modules.

Provide a `doctor`/preflight workflow that checks server compatibility,
`wal_level`, permissions, publication/slot configuration, table identity/type
support, filtering/RLS implications, and local storage access. Explain actionable
failures without exposing passwords or full connection URLs.

Separate read-only inspection/preflight from source setup. Generate inspectable
SQL for tool-owned publications, slots, replica-identity settings, and optional
context support. An explicit setup command may apply documented changes in the
operator's chosen development database. Never silently change shared server
configuration, discard existing slots, or alter unrelated tables.

Give resources stable ownership and lifecycle rules. Closing a connection does
not remove a persistent replication slot. Show lag, durable progress, last
activity, capture errors, disk usage, and retention implications; provide explicit
cleanup of owned resources without harming other clients. Handle WAL retention
limits by diagnosing loss and ending coverage honestly, not by dropping history
or acknowledging unpersisted events.

Include a self-contained local Postgres harness using Docker Compose, with
loopback-only ports, disposable development credentials, health checks, bounded
startup, scoped cleanup, and unique test namespaces. A native local Postgres
alternative is useful where practical. Tests must never target an arbitrary
ambient `DATABASE_URL`. No paid API, user-supplied secret, or cloud account is
required for this harness.

### 6.2 Prisma and other clients

Database-level capture must work when writes originate in Prisma, plain SQL, or
another client. The SDK must have no Prisma dependency or dependency on a
generated Prisma schema. Prove basic capture without application instrumentation.

Add a small optional integration that associates allowlisted request/operation
metadata with a real source transaction. Prefer an explicit transaction wrapper
or context-emission helper using documented public APIs. A transactional logical
message is one possible transport; prove it is emitted and consumed on the same
transaction/connection rather than assuming process-local context crosses into
the replication stream.

Requirements:

- Verify the chosen Prisma version's public extension/transaction APIs before
  implementation. Do not use removed middleware or private query-engine hooks.
- Preserve original return values, error propagation, transaction boundaries,
  rollback behaviour, connection ownership, and isolation choices. Do not wrap
  arbitrary user queries in hidden transactions for instrumentation convenience.
- Do not promise universal transparent instrumentation of nested writes, batch
  transactions, connection pools, or proxies. Clearly document and test the
  supported context helper. Uninstrumented operations remain recordable and
  display context as unavailable.
- Keep emitted metadata bounded and allowlisted; no implicit capture of HTTP
  bodies, SQL parameters, credentials, source paths, or arbitrary user objects.
- Resolve asynchronous context enrichment without overwriting recorded database
  facts or guessing association from timestamps.
- Provide compile-tested public API examples and a package consumer test using
  the packed integration against a real generated Prisma client.

The Prisma sample should model checkout with orders, line items, and inventory,
including a reproducible incorrect total or stock mutation. Demonstrate nested
writes and explicit multi-table transactions, rollback, and an instrumented
operation whose context appears in the debugger. The plain SQL example should
produce equivalent domain outcomes through the same capture path.

Do not modify upstream Prisma, open external PRs, or imply maintainer endorsement.
Deliver a clean integration surface that maintainers could choose to adopt.

## 7. Local application and developer experience

Build a finished application with an intentional visual design: readable tables,
clear hierarchy, restrained colours, visible selection state, useful empty/error
states, and responsive layouts. Prefer an excellent desktop investigation
experience that remains usable on smaller screens over a decorative dashboard.

### 7.1 Required browser journeys

1. **Start and orient:** launch locally, open the browser, and choose a recording
   or the bundled sample. The sample is clearly labelled and exercises the real
   storage, reconstruction, query, and presentation paths. Explain how to connect
   an existing development database from the same onboarding screen.
2. **Find a recording:** display source/epoch, capture mode, schema summary,
   transaction count, time range, completeness, status, and storage size. Open,
   import, export, rename locally, or explicitly delete a recording. Do not
   confuse a stopped valid recording with failed capture.
3. **Explore the timeline:** navigate whole committed transactions forwards and
   backwards, jump by position/time, filter by table, operation, or recorded
   context, and retain selection in the URL. Provide keyboard controls and a
   paginated/virtualised list; a slider cannot be the only precise control.
4. **Inspect a transaction:** show recorded context when present, affected tables,
   ordered events, row identities, and before/after field changes. Include a
   clear distinction between per-event changes and the transaction's net effect.
5. **Follow a row:** show its recorded lifecycle, including deletion and supported
   key changes. Render NULL, absent, unchanged, redacted, binary, decimal, and
   timestamp values unambiguously. Let users inspect large permitted values.
6. **Compare states:** select two committed positions and inspect deterministic
   table/row differences. Filtering and pagination must use the selected states,
   never current source data. Show counts and truncation honestly.
7. **Query a past state:** choose a committed boundary and execute SQL against a
   separate reconstructed workspace. Support joins, filtering, and aggregation
   for the documented type/schema subset. Show selected position, schema, query
   duration, row limits, cancellation, and SQL errors.
8. **Investigate a rule:** save an invariant query, scan a selected range, cancel
   it, or inspect the first observed violation. Link the result to the responsible
   recorded boundary and before/after data without claiming application causality.
9. **Share and resume:** export a recording, reopen it in a fresh local workspace,
   and reproduce the same row history, diff, and historical query offline. Deep
   links identify the same position when that recording is present locally.
10. **Recover from trouble:** display interrupted capture, unsupported schema,
    invalid imports, expired coverage, disconnected source, and failed queries
    with an actionable next step. Never silently substitute sample data.

Every visible action must be implemented, keyboard reachable, and tested where
it matters. No dead buttons, simulated progress, unexplained internal enum names,
placeholder charts, fixture-specific query answers, or production test switches.

Use semantic HTML, accessible labels, visible focus, non-colour-only diffs,
announced async status, reduced-motion support, and readable contrast. Preserve
table headers and context when scrolling. A full IDE/editor dependency is not
needed for a usable SQL input with examples, results, and error locations.

Keep domain calculations outside components. Have focused browser state/query
modules and explicit view models. Cancel superseded work and reject stale results
so rapid timeline movement cannot label one state's rows with another position.

### 7.2 CLI, headless usage, and local API

Provide cohesive commands for the following operations. Choose consistent names
and implement the help text, examples, and error handling completely:

- Start the application against a workspace and load the bundled sample.
- Inspect/check a source configuration and generate/apply explicit setup.
- Record from Postgres; show progress; stop safely; resume a supported session.
- List, inspect, validate, rename, export/import, and remove local recordings.
- Inspect a transaction/row and compare two states without a browser.
- Run a historical SQL query and scan an invariant range headlessly.
- Inspect status/diagnostics and clean up only explicitly owned source resources.

Use machine-readable JSON output with stable codes for automation, human output
for interactive use, and separate stdout from diagnostics on stderr. Document
exit codes, cancellation, timeouts, result truncation, and CI use. Support config
files/environment inputs at composition boundaries with explicit precedence.
Avoid making passwords part of shell history or routine process arguments.

The local API used by the UI must be documented and validated, including version,
errors, cursor semantics, resource limits, and authoritative selected-position
fields. HTTP DTOs are transport contracts, not database rows leaked directly.
Library use must not require HTTP. Importing a library cannot start a server,
connect to a source, read ambient credentials, or modify global state.

Bind to loopback by default and reject unintended remote exposure. Protect local
mutation endpoints against cross-origin requests and DNS rebinding with explicit
Host/Origin validation and a session mechanism where appropriate. Serve bundled
assets locally. No tracking, third-party fonts, remote scripts, analytics,
automatic update checks, telemetry, or hidden network calls.

## 8. Storage, exchange format, and query isolation

Define a documented, versioned recording format that contains the baseline,
schema, ordered committed changes, source identity/positions, coverage, optional
context, capture configuration fingerprint, and integrity metadata. It must be
independent of SQLite's private schema and importable through public contracts.

Use a streamable format, such as a manifest plus bounded JSONL records, with a
clear framing and validation contract. Compression is optional. Avoid loading an
entire recording or giant compressed entry into memory. Bound record size,
nesting, declared counts, expanded bytes, files, and aggregate import work.

Validate checksums, references, ordering, duplicates, key/schema consistency,
format versions, and completeness before publishing an imported recording.
Stage imports and atomically publish them. A corrupted or cancelled import must
leave existing data untouched. If using archives, reject traversal, absolute
paths, links, duplicate destinations, and decompression bombs. Checksums detect
corruption; do not market them as authenticity guarantees.

The local store must have versioned migrations, transactional writes, enforced
constraints, bounded indexed reads, ownership/concurrency rules, and graceful
shutdown. Document what happens when two processes open the same workspace.
Reject unsupported future versions instead of overwriting them. Indexes and
checkpoints must be rebuildable from validated authoritative history.

Support explicit recording deletion and configurable storage limits. Whole
recording retention is sufficient initially. Never delete a prefix that a
retained checkpoint/history range requires. Disk-full and permission failures
must not create a valid-looking truncated recording or advance capture progress.

Historical SQL runs on disposable reconstructed state only. Keep source
credentials and source connections out of the query worker. Do not execute
original DML, source triggers, or imported SQL scripts during reconstruction.
Build supported schemas from validated metadata and bind recorded values.

Implement and test a read-only historical query policy using the SQL engine's
enforcement and appropriate isolation, not a starts-with-SELECT regex. Account
for writable CTEs, multiple statements, transaction-control escape attempts,
functions, DDL, COPY, and extensions. Do not expose source-installed functions or
host filesystem/network bridges. Restrict the supported query surface where
needed and make rejections clear.

Use bounded execution, row/byte limits, cancellation, and a disposable worker or
process whose failure cannot corrupt history or freeze the UI. A worker alone
is not a security sandbox: describe the actual trust boundary and validate the
selected engine's behaviour. Arbitrary hostile remote SQL execution is outside
the supported product. Test that rejected queries cannot alter the next query's
historical answer or the authoritative recording.

State what historical results reproduce: recorded table values under the
recorded schema/projection. They do not reproduce an application's original
MVCC read snapshot, planner decisions, sequence allocator, volatile functions,
or external state. Time-dependent queries evaluate in the inspection environment
unless an implemented feature explicitly supplies different semantics.

## 9. Privacy and operator control

Database recordings can contain sensitive data. Keep the controls concrete and
usable rather than adding a generic compliance checklist:

- Require an explicit table allowlist for live capture. Preflight exposes what
  will be recorded, the permissions used, and source configuration changes.
- Keep all data local by default. Credentials must never enter recording files,
  export manifests, error pages, URLs, screenshots, fixtures, or ordinary logs.
- Add a deterministic column policy for excluding or redacting selected values
  before durable storage and diagnostic logging. Clearly label lossy recordings.
  Unsupported queries involving unavailable values must fail explicitly rather
  than returning fabricated NULLs or misleading aggregates.
- Do not allow a lossy column policy to break required identity or replay keys
  silently. Validate policy compatibility. A share-safe derived export must say
  which capabilities it retains and use the same policy/validation layer.
- Render recorded text as data, never HTML or terminal control sequences. Test
  malicious row contents, file names, metadata, and error strings.
- Create local state with appropriately restrictive permissions where supported;
  explain platform limitations. Only delete explicitly selected recordings or
  tool-owned temporary resources. No broad filesystem cleanup commands.
- Document local source setup, rollback/cleanup of owned setup, WAL/disk retention,
  recording deletion, and the consequences of losing a replication slot.

Do not claim SOC 2, enterprise certification, encryption at rest, production
safety, perfect anonymisation, or zero capture overhead without implementation
and evidence. An honest development-tool support boundary belongs in the user
documentation and onboarding, without dominating every screen.

## 10. Maintainability and engineering discipline

Use these local projects as read-only inspiration where present:

- `/home/zak/personal/repo-tracker`: `AGENTS.md`, `docs/architecture.md`,
  `docs/boundaries-and-rules.md`, architecture checks, test harnesses, and hooks.
- `/home/zak/personal/personal-ai`: `AGENTS.md`, `docs/02-architecture.md`,
  `docs/03-boundaries-and-rules.md`, injected runtime dependencies, adapter
  contracts, failure handling, package smoke tests, and hooks.

Read selectively. Extract the principles; do not copy thousands of lines of
unrelated rules, provider integrations, scripts, dependencies, or project-specific
policy. These repositories must not become runtime or build dependencies.

Required engineering practices:

- Deliver thin, independently understandable commits. Use TDD for nontrivial
  correctness and behaviour: demonstrate a focused failure, implement the change,
  run relevant checks, and commit the completed slice.
- Prefer cohesion, explicit data flow, composition, immutable public inputs,
  discriminated unions, pure deterministic policy, and narrow interfaces.
  Document state transitions and resource ownership where they are nontrivial.
- Enable strict TypeScript, unchecked-index protection, exact optional property
  checking where compatible, and no implicit `any`. Avoid broad assertions,
  unvalidated JSON casts, non-null assertions, and error swallowing.
- Inject time, IDs, network, scheduling, process execution, and storage at their
  real boundaries. Keep ambient globals out of domain/application logic. Do not
  wrap every language primitive in an interface.
- Give each policy one owner: ordering, value encoding, selectors, checkpoint
  eligibility, coverage, redaction, defaults, and error projection. Share that
  owner across CLI, API, UI, mock, persistence, and real source paths as applicable.
- Keep modules focused. Around 300 non-generated production lines triggers a
  cohesion review; above 500 requires a documented justification or refactor.
  Huge orchestration files, enormous config switches, broad context bags, and
  conditional feature accumulation are unacceptable. These are review thresholds,
  not a reason to split coherent code into arbitrary tiny files.
- Avoid catch-all `utils`, generic base classes, pass-through service layers,
  boolean flag combinations, speculative plugin systems, and duplicate parsers.
- Enforce public exports and dependency direction through tooling. Prove a new
  adapter can be added without changing deterministic engine or UI internals.
- Test boundaries and observable behaviour, not private implementation details
  or line coverage alone. Shared fixtures should satisfy invariants by default;
  malformed fixtures must be explicit and named.
- Refactor repeated test setup into focused layer-specific helpers. Do not build
  one omniscient test harness or import test composition into production code.
- Record durable lessons as concise architecture rules and tests, not a growing
  transcript of agent decisions. Keep `AGENTS.md` short and navigational.

Review every substantial milestone for correctness, maintainability, and product
usability before proceeding. Use a fresh independent review agent when available;
the review task is read-only, bounded to the completed milestone, and reports
findings to the implementer. The `thermo-nuclear-code-quality-review` skill may
be used if available and applicable. If independent agents are unavailable,
perform an explicit separate review pass and say so. Resolve actionable findings
and rerun affected checks. Do not repeatedly spawn reviewers for unchanged code
or parallelise conflicting edits to shared contracts.

## 11. Hooks, formatting, linting, and CI

Install real checked-in hooks early, before substantive product implementation:

- `.githooks/pre-commit`: staged Prettier/ESLint checks or fixes plus a practical
  fast gate covering types, architectural boundaries, focused tests, docs, and
  secrets. Preserve partially staged and unrelated changes.
- `.githooks/commit-msg`: Conventional Commits validation.
- `.githooks/pre-push`: the complete credential-free local quality gate.
- `hooks:install` and `hooks:check`: configure and verify repository-local
  `core.hooksPath` and executable hook files. CI explicitly installs/verifies
  repository hooks when appropriate; package consumers need no Git checkout.

Use repo-local binaries without network downloads at hook execution time. No
`--no-verify`, disabling hook execution, removing assertions, relaxing thresholds,
or broad lint suppressions to get a failing commit through. Diagnose failures.
Keep the first setup slice coherent so hooks work once installed.

Adopt tooling comparable in purpose to the inspiration repositories:

- TypeScript build/typecheck; ESLint with TypeScript/import/test rules; Prettier.
- Vitest, appropriate DOM/component assertions, and Playwright for browser E2E.
- Dependency-cruiser with failing and allowed boundary fixtures.
- Knip for unused code/dependencies and a calibrated duplication check.
- Markdown linting, spellcheck with a small project dictionary, secret scanning,
  deterministic package manifest ordering, and commit-message checks.

Tool count is not the goal. Configure useful checks, narrowly explain necessary
exceptions, and avoid redundant plugins or an elaborate custom task runner.
Generated files and external fixtures get precise exclusions, not broad source
exemptions. Keep development dependencies out of production bundles.

Provide documented commands with these responsibilities:

- `npm ci`: reproducible dependency installation from the lockfile.
- `npm run dev`: start the usable local app with sample onboarding.
- `npm run build`: build all distributable code and required assets.
- `npm run check`: types, lint, format, architecture, hygiene, and deterministic
  unit/contract tests; no external service, Docker, or browser requirement.
- `npm run test:integration`: real disposable Postgres and Prisma/SQL integration;
  explicit failure if prerequisites are unavailable.
- `npm run test:e2e`: production-build browser and process journeys through real
  local composition.
- `npm run smoke:package`: pack, install in isolation, import the SDK, and run the
  actual packaged CLI/UI.
- `npm run benchmark`: reproducible recording/reconstruction/query resource
  measurements.
- `npm run check:full`: compose every required release-validation lane, including
  real Postgres, browser E2E, recovery, and package smoke.

Names may be refined consistently. Do not leave an E2E/recovery/package suite
outside the aggregate release gate. Check command composition with a small
manifest test when it would prevent suites from being accidentally omitted.

CI must run the fast gate, production builds, real Postgres integration, browser
E2E, and package smoke without private secrets. Pin supported tool/database
versions and configure bounded timeouts and failure artifacts. Include a useful
OS/Node matrix for portable SDK/CLI behaviour and a Linux Postgres service lane.
Do not claim OS/version support solely because a workflow file lists it; distinguish
locally verified, CI-verified, and unverified platforms in the release evidence.

## 12. Test and evidence requirements

### 12.1 Deterministic and contract tests

Cover identity/value encoding round trips, exact numeric/JSON/binary/time values,
schema/type validation, ordering, duplicates, empty recordings, table/row diffs,
before/after selection, initial-snapshot semantics, checkpoints, visibility of
whole commits, and explicit incomplete/unsupported outcomes.

Share conformance suites across real and in-memory storage and sources where
their contracts coincide. Include adversarial streams with disconnects, repeated
transactions, partial batches, malformed events, missing history, timestamp ties,
and transaction IDs whose numeric order differs from commit order.

Use deterministic generated histories or a small property-testing dependency
where it materially improves confidence. Verify reconstruct-at-position against
an independent reference model; do not merely call the production reducer twice.
Test first invariant failure when the predicate later recovers.

### 12.2 Actual database and recovery tests

Against real disposable Postgres, prove:

- Baseline plus concurrent writes across the snapshot/stream handoff produces
  correct captured state without a gap or duplicate application.
- Multi-table commits publish atomically; rollback and savepoint rollback leave
  no aborted events in committed history.
- Opposite start/commit order, repeated updates, primary/composite key changes,
  deletes, permitted cascade effects, and supported large/TOAST values replay
  correctly. Unsupported cases fail with a specific boundary.
- Capture survives a recorder crash/restart and replayed source messages without
  duplicating or dropping committed data. Include process termination tests at
  meaningful persistence/acknowledgement windows.
- Source disconnect, invalid slot/source identity, schema change, corrupt local
  progress, disk-full simulation, and cancellation preserve the last valid range.
- Queries against reconstructed committed states match independent SQL results
  taken at controlled source boundaries for supported columns and query semantics.
  Real-source observations, not only generated fixtures, are the oracle.
- Prisma and plain SQL consumers both work; optional metadata associates with the
  correct transaction and rolls back with it. Raw/uninstrumented writes are not
  lost merely because they bypass an ORM helper.
- Slot/publication cleanup only touches owned resources, and normal stop/resume
  retains what the documented lifecycle requires.

Use test-controlled barriers and bounded polling instead of arbitrary sleeps.
Keep destructive fixtures confined to explicitly created disposable resources.

### 12.3 Browser, process, and package validation

Playwright must drive the built app through the actual local server/storage/query
composition for the main journeys: open sample, select a transaction, inspect a
row, compare two states, execute a historical join/aggregate, find an invariant
failure, export/import, and reopen after restart. Assert meaningful data, not
only page titles or screenshots. Add at least one real-capture-to-browser flow.

Cover keyboard navigation, focus, empty/error states, malicious rendered text,
deep links, rapid selection changes, cancellation, import failure, query limits,
and reconstruction status. Automated accessibility checks supplement manual
inspection; they do not prove complete accessibility by themselves.

Process tests exercise actual CLI arguments, JSON/stdout/stderr contracts, exit
codes, config precedence, signals, port conflicts, and shutdown with work pending.
Package smoke installs tarballs in a temporary consumer directory outside the
workspace, runs without TypeScript/dev tooling, opens a recording, executes a
historical query, serves bundled assets, and imports documented SDK exports.
Check that optional dependencies do not leak through the SDK's import graph.

No secrets, real customer data, mocked implementation-specific selectors, or
test-only bypasses in production flows. Deterministic sample mode must still use
real domain policy, durable storage, and SQL execution.

### 12.4 Lightweight means measured

Create small and larger reproducible synthetic datasets with a fixed seed, for
example 10,000 and 100,000 row changes across realistic transactions. Record the
dataset, machine, Node/database versions, command, and raw machine-readable
measurements. Measure:

- SDK/package size, production dependency graph, application install footprint,
  browser asset size, cold start, and idle memory.
- Capture throughput/lag and overhead versus an equivalent uncaptured workload.
- Ingest/reconstruction throughput, checkpoint benefit, random historical access,
  paginated timeline latency, representative historical SQL, and peak memory.
- Recording/export size, cancellation responsiveness, and disk growth under load.

Set sensible budgets from a measured initial baseline, record them early, and
prevent unexplained regressions. Avoid flaky wall-clock CI gates on shared hosts;
use deterministic resource/count/bundle bounds where possible and a separate
repeatable benchmark lane for timing. Do not invent performance numbers or market
the tool as lightweight merely because its source code is small.

## 13. Open-source product documentation

The root `README.md` is for users evaluating and installing the finished product.
It must be a polished, accurate open-source README, not a notes dump, task ledger,
agent handoff, wall of architecture rules, or a claim that planned work exists.

Give it a strong, concise opening explaining the problem and actual solution,
then cover:

- A real screenshot or short locally generated walkthrough of the completed app,
  with descriptive alt text. No invented badges, users, benchmarks, or endorsements.
- What users can do, who it is for, and the supported Postgres/Node/ORM scope.
- A tested copy/paste quick start requiring no API keys: install/build from source
  or a locally available package, start, and inspect the bundled sample.
- A separate concise path for connecting an existing local development database,
  including prerequisites, generated setup, table selection, recording, stopping,
  and cleanup. Explain all source-side changes before the relevant command.
- A minimal SDK example, an optional Prisma context example, and links to runnable
  examples. Verify snippets against the actual public package API.
- Historical SQL, row/transaction navigation, headless/CI usage, portable recordings,
  and links to deeper guides rather than every option in the opening screenful.
- Privacy, retention/WAL implications, explicit limits, and truthful explanations
  of committed-state history versus application replay.
- Configuration/troubleshooting, development/contribution, licence, security
  reporting, and a concise architecture pointer.

Add focused documentation for installation/configuration, capture/cleanup,
recording format, SDK/API, custom adapters, Prisma integration, CI workflows,
correctness, supported types/schema changes, privacy, troubleshooting, benchmarks,
and release verification. Avoid repeating the same rules in many files. Keep
ADRs short and reserve them for consequential choices.

Provide `CONTRIBUTING.md`, `SECURITY.md`, a changelog, suitable issue/PR templates,
and a permissive open-source licence; default to MIT unless existing repository
licensing dictates otherwise. Preserve dependency notices and verify redistribution
of packaged assets. Do not invent a security email or support SLA; use a verified
maintainer contact if available, otherwise accurately describe available channels.

Keep `AGENTS.md` as a concise map to the canonical architecture/correctness rules,
validation commands, commit identity, and workflow. Put implementation progress,
remaining work, and review evidence in dedicated development documents rather
than in the product README. Do not put absolute paths from the author's machine
into user installation instructions or public example imports.

## 14. Autonomous delivery sequence

Start by inspecting this repository, preserving existing work, reading applicable
instructions, and checking available Node/npm, Git, browser, and Postgres/Docker
capabilities. This repository initially contains this goal file as its first
commit. Use the personal Git identity already configured for this repository or
the applicable `/home/zak/personal/.gitconfig-personal` identity, never work Git
credentials.

Create a concise implementation plan and acceptance map, then implement immediately.
The plan is a tool for completing the product, not a substitute deliverable.
Use this dependency-aware sequence, refining slice sizes as needed:

1. Establish the supported scope, correctness contract, initial ADRs, package
   boundaries, quality tooling, hooks, and CI skeleton with executable checks.
2. Prove the highest-risk real Postgres snapshot/stream handoff and exact value
   handling early. Keep exploratory experiments bounded and replace them with
   production-quality adapters/tests; do not build the entire UI atop an unproven
   capture assumption.
3. Finish canonical events, durable ingest, reconstruction, checkpoints,
   conformance tests, and versioned import/export through a headless vertical slice.
4. Finish live capture lifecycle/recovery, source preflight/setup/cleanup, and
   credential-free real Postgres integration harnesses.
5. Build the CLI/local API and finish the browser investigation journeys using
   the same application services. Add real embedded historical SQL and invariant
   scans; no parallel fixture-only query implementation.
6. Finish Prisma/plain SQL/custom-source integrations and demonstrate portable
   SDK consumption, correct transaction metadata, and offline recording sharing.
7. Complete security/privacy controls, accessibility, error/recovery behaviour,
   package distribution, benchmarks, user documentation, and release validation.
8. Conduct a final independent correctness/maintainability review and a fresh
   consumer walkthrough from packed artifacts. Fix actionable findings, rerun
   affected checks, and then run the aggregate release gate.

Keep user-facing progress updates concise and factual. Preserve a durable status
document across context compaction with completed slices, tests actually run,
current task, concrete blockers, and next steps. Continue from it without
restarting or repeatedly redoing unchanged work.

Deterministic adapters keep unit development independent of external services.
Ordinary installation of public build dependencies, browser binaries, and local
database images is permitted subject to the active environment's permissions.
No user API keys are needed. Do not turn missing cloud credentials into a blocker.

If Docker is unavailable, investigate a safe native local Postgres path and
continue independent work. If the environment truly cannot run a required test,
record the attempted command and concrete limitation, leave that requirement
unverified, and implement/run every unaffected path. A mock or skipped test is
not evidence that live capture works. Do not mark the complete product goal
achieved while mandatory implementation or verification remains outstanding.

Commit completed validated slices without waiting for routine user confirmation.
Do not publish npm packages, create cloud resources, expose a public service,
modify upstream projects, or push releases as part of this goal. Prepare reviewable
local release artifacts and an accurate final handoff. Respect any existing
explicit user authorisation concerning remotes; never force-push or rewrite the
initial goal commit.

## 15. Required completion evidence

Before declaring success, verify every item below and record the command/result
or relevant artifact in a concise `docs/release-verification.md`. Mark a check
unverified when it was not actually run. Do not use a green aggregate command to
hide skipped prerequisites or excluded suites.

- [ ] The project is a functioning installed application and reusable SDK, not
      just a sample scenario, source scaffold, or architecture document.
- [ ] All promised browser journeys and CLI commands work through canonical
      application services and real local storage/query adapters.
- [ ] A clean consumer can install/build, launch, inspect a bundled recording,
      query history, export/import, and reopen offline without credentials.
- [ ] Actual local Postgres capture passes snapshot handoff, commit/rollback,
      concurrency, type fidelity, reconnection, crash, and schema-boundary tests.
- [ ] Historical reconstruction and SQL results agree with independent source
      observations at controlled committed boundaries for the supported subset.
- [ ] A real Prisma example and plain SQL example work; optional transaction
      context is accurate; database capture does not depend on that context.
- [ ] Public SDK/custom-source usage works from packed artifacts without internal
      paths, Prisma, the UI, or database-engine dependencies leaking into the SDK.
- [ ] No source rewind, fabricated history, silent coverage gap, precision loss,
      accidental credential capture, or unchecked query mutation remains in the
      supported path.
- [ ] Recording/import validation, cancellation, cleanup, resource bounds, and
      restart behaviour are exercised with realistic failure tests.
- [ ] Pre-commit, commit-message, and pre-push hooks are installed and verified;
      types, ESLint, Prettier, architecture, documentation, and hygiene gates pass.
- [ ] Unit/contract, actual Postgres integration, browser/process E2E, recovery,
      and package smoke suites pass; the full gate includes every required lane.
- [ ] CI configuration is complete and locally reproducible without private
      secrets; evidence distinguishes configured workflows from executed runs.
- [ ] Measured dependency, size, memory, storage, startup, and workload results
      substantiate the lightweight design and document its limits.
- [ ] The README and user/integration guides describe the actual finished product,
      with tested examples, real visuals, accurate compatibility, and licence.
- [ ] Actionable final review findings are resolved; no critical/high-severity
      correctness or safety issue, inert advertised control, or required TODO is
      being deferred under the label of a completed release.
- [ ] The repository has a coherent incremental commit history, the original
      goal commit is preserved, generated/private state is ignored, and final
      worktree status is clean apart from explicitly identified user-owned work.

Finish with a short, self-contained report: what works, how to run it, the SDK and
integration entry points, verification actually completed, measured limits,
unsupported scope, release artifact locations, and final commit. Do not call the
product complete merely because substantial effort has been spent. The intended
outcome is a finished, maintainable, useful first release within this contract.

## 16. Technical references and verification guidance

Consult current official documentation for the exact versions selected. These
links ground the architecture; they are not permission to assume untested
behaviour or to use stale APIs. Keep new external dependencies and protocol
assumptions justified in the relevant ADR.

- [PostgreSQL logical decoding concepts and exported snapshots](https://www.postgresql.org/docs/current/logicaldecoding-explanation.html)
  explain coordinating a baseline with a change stream and why replay must handle
  repeated delivery.
- [PostgreSQL logical replication protocol messages](https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html)
  specify transaction positions, relation metadata, and tuple value markers.
- [PostgreSQL logical replication restrictions](https://www.postgresql.org/docs/current/logical-replication-restrictions.html)
  explain why row capture does not constitute arbitrary schema or sequence replay.
- [PGlite documentation](https://pglite.dev/docs/)
  describes an embedded Postgres WASM option for credential-free local SQL. Verify
  supported types, execution limits, asset packaging, and differences from the
  actual source Postgres version.
- [Prisma extension examples](https://docs.prisma.io/docs/orm/prisma-client/client-extensions/extension-examples)
  provide a starting point for public integrations. Locate and verify the
  version-specific transaction/extension APIs used by the runnable example.

The project's differentiation is a usable modular debugger around recorded
Postgres state, with honest correctness guarantees and integration seams.
Existing time-travel databases and debuggers are prior art; do not claim to have
invented database history or to offer unverified universal compatibility.
