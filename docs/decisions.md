# Decisions

## Runtime and supported source

Pin Node 24.20.0 LTS and TypeScript 5.9.3, ESM and strict compiler options.
Node 24 has built-in SQLite; its synchronous API will be isolated in a worker.
The SDK has no production dependencies or runtime-specific imports.
Postgres 16 is the initial source major; native 16.15 is available for validation.
Browser and Prisma versions will be pinned when their actual integrations are
verified. Package names are provisional; nothing has been published.

References checked during setup:

- [Node releases](https://nodejs.org/en/about/previous-releases)
- [Node 24 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- [Postgres 16 snapshot coordination](https://www.postgresql.org/docs/16/logicaldecoding-explanation.html)

## Dependency ledger

The SDK has zero production dependencies. Build tools are development dependencies
only. The source adapter adds:

| Dependency             | Pin    | Licence | Purpose / alternative                                                                                                                                                                           |
| ---------------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pg                     | 8.23.0 | MIT     | Maintained PostgreSQL connections, authentication and query transport; avoids implementing the wire protocol. Postgres.js considered, but explicit snapshot/replication connections fit pg.     |
| pg-logical-replication | 2.5.0  | MIT     | pgoutput decoding and streaming flow control; avoids a bespoke replication transport. Exact parsers and acknowledgement behaviour need adapter-level handling documented in the protocol guide. |

Both are imported only by `source-postgres`; the SDK import graph stays isolated.
The logical transport also installs EventEmitter2 (MIT). All transitives are
pinned in the npm lockfile. Initial Linux allocated directory measurements:
pg 164 KiB, logical-replication 260 KiB, EventEmitter2 100 KiB. These partial package
measurements are not full application-install cost or release benchmark evidence.
The full transitive graph and packaged footprint remain to be measured.

The CLI uses Node's built-in argument parser and three internal MIT packages:
SDK contracts, local storage and portable exchange. No external runtime dependency
is added for command parsing; the current finite command grammar does not need a
framework. Its executable owns environment/configuration, process signals and
stdio; the injectable library entry point has no import-time process behavior.

## Historical query engine feasibility dependency

PGlite is pinned to `@electric-sql/pglite@0.5.8` (Apache-2.0) as the query adapter's runtime
dependency and a root development dependency for executable isolation evidence. npm reports 25,437,263 unpacked
bytes; its installed directory occupies approximately 26 MiB on the tested Linux
filesystem. These are package measurements, not full application footprint.
The embedded engine reports PostgreSQL 18.3. The SDK remains dependency-free;
only the query adapter imports PGlite at runtime. PostgreSQL-compatible embedded execution avoids
translating historical queries into a different SQL dialect; the production
resource boundary remains unresolved. See `historical-query-policy.md`.

The source and query adapters share `@time-travel-sql/sql-postgres` (internal MIT)
for identifier/literal/parameter construction. It depends on SDK validation only.
This prevents query workers from importing source transports or storage code;
dependency-cruiser explicitly enforces that separation and browser exclusion.
No ORM or additional query-building runtime dependency is introduced.
