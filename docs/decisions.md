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

The SDK currently has zero production dependencies. Build tools are development
dependencies only. Each future runtime dependency must add purpose, licence,
alternatives and importing package here, plus measured installed cost in the
benchmark evidence before release.
