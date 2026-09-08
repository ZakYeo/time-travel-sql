# Historical SQL adapter

`@time-travel-sql/query-pglite` implements the SDK's `HistoricalQueryEngine` port
using pinned PGlite 0.5.8 in a new owned Node worker for each query. The library
works with reconstructed recording views; CLI query composition remains pending.

```ts
import { createHistoricalQueryEngine } from '@time-travel-sql/query-pglite';
import { decodeQueryRequest } from '@time-travel-sql/sdk';

const engine = createHistoricalQueryEngine();
try {
  // Keep the borrowed reconstruction view open until query settles.
  const result = await engine.query(
    view,
    decodeQueryRequest({
      sql: 'SELECT id, amount FROM public.orders ORDER BY id',
      limits: { timeoutMs: 30000, maxRows: 1000 },
    }),
    signal,
  );
  // result.columns retain ordinal names/OIDs; cells are exact text or SQL NULL.
} finally {
  await engine.close();
}
```

## Recorded values and schema

The adapter validates reconstruction metadata and the complete canonical row
stream before executing SQL. It rejects mismatched counts, bytes, ordering and
row identities through the SDK's reconstruction validator. The worker receives
only schema, query limits/SQL and individually acknowledged rows. It receives no
recording path, source connection, capture receipt or credentials. No original
DML, scripts, source functions or triggers are executed.

The shared SQL builder quotes schema/table/column names, qualifies built-in types,
constructs validated type modifiers and preserves primary keys, including composite
key order. Reproducing the key constraint also preserves PostgreSQL's primary-key
functional dependency for GROUP BY. Bound parameters and text serializers preserve
all fourteen supported scalar types without JavaScript numeric, JSON, date or byte
coercion. Result parsers retain PostgreSQL text for every type in the disposable
catalog, including arrays and expression types outside capture's scalar surface.
PostgreSQL still normalizes representations, such as JSONB whitespace and temporal
output; row inspection retains the recording's own canonical representations.

Each column containing any unavailable value loses its SELECT grant for the entire
query workspace. Available columns and COUNT(\*) remain usable. Filtered queries
cannot read even known cells in that denied column. Non-key columns permit private
NULL placeholders during loading; their unavailable columns cannot contribute to
query results. The disposable schema therefore does not reproduce all catalog
constraint details, including non-key NOT NULL metadata. Required key values must
remain available. Capture-time column policy and provenance remain separate work.

## SQL policy and trust boundary

The engine starts with its default in-memory virtual filesystem, no extensions,
no filesystem bridge and an empty worker environment. Captured namespaces beginning
with `pg_` or named `information_schema` are rejected. Recorded non-public tables
must be schema-qualified; search_path is fixed to pg_catalog, public. Time zone,
DateStyle and bytea output are set to UTC, ISO/YMD and hex.

Before execution, the owner grants only available columns to a restricted reader,
revokes public catalog function execution, and admits a fixed function-name list
plus pristine built-in operator implementations. This supports common aggregates,
operators, casts and selected text/date functions. Other functions fail explicitly.
After changing session authorization, SQL enters PostgreSQL's single-statement
extended protocol as a DECLARE cursor inside BEGIN READ ONLY. Grammar, function
permissions and read-only transactions jointly enforce the boundary. PGlite's
username option is not used as a security boundary. See the original and subsequent
adversarial evidence in `historical-query-policy.md`.

Statements, functions or unavailable-column access rejected by the engine produce
safe QUERY_REJECTED diagnostics. Engine resource exhaustion reports LIMIT_EXCEEDED;
unexpected engine failures report QUERY_FAILURE. Engine stdout/stderr are consumed
without logging because native diagnostics may contain SQL or values. Public SQL
errors omit engine detail and original SQL. A fresh engine per query prevents
session state from surviving rejection. An actual SQLite test compares authoritative
portable export bytes before/after rejected SQL and checks both committed selections.

This is a local inspection facility for recorded values under the recorded
schema/projection. It does not reproduce the application's original MVCC snapshot,
planner, sequence allocator, external state or volatile-function results. Permitted
time-dependent functions evaluate in the inspection environment. Arbitrary hostile
remote SQL execution is outside the supported product. A worker is not an OS sandbox.

## Bounds and ownership

The SDK's query limits govern declared/validated input size and rows, SQL text,
result columns, rows, cell bytes and compact JSON result bytes. Only one query runs
per engine instance; competing requests fail instead of entering an unbounded queue.
The parent sends one validated row at a time and waits for acknowledgement. Results
are fetched one row at a time, fail closed on limits and are revalidated by the parent
before delivery. There is no silent truncation or successful partial result.

The parent owns a deadline spanning initialization, row loading, policy preparation,
execution, result validation and teardown. It forcibly terminates the worker on
cancellation or timeout and awaits termination. The query borrows its reconstruction
view and never closes it. An uncooperative borrowed read is detached with rejection
observation so it cannot block owned engine teardown. Callers still own that view's
resources. Engine close cancels/drains active work, retains cleanup failures and is
idempotent. Any cleanup failure prevents further queries on that engine instance.

PostgreSQL work_mem is 4 MiB and temporary-file usage is capped at 64 MiB. The worker
has a 128 MiB old-generation JavaScript heap limit. These are not a hard total memory
bound: PGlite materializes an individual fetched row before output validation, and
WASM linear memory and other allocations are outside the JavaScript heap limit.
A large expression or intermediate result can still consume substantial memory.
Stronger process/OS memory containment remains unresolved; do not describe this as
an arbitrary-SQL sandbox or a complete total-memory guarantee.

The current validation gate passes 323 unit tests and 15 policy/adapter tests.
The native PostgreSQL suite passes 62 tests after the shared builder extraction.
SDK, shared SQL and query adapter tarballs also install into an isolated offline
consumer and execute a primary-key GROUP BY query with exact large numeric output.
No packages or releases have been published.
