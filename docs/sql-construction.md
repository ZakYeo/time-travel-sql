# SQL construction

Dynamic PostgreSQL snapshot, catalog and publication setup statements use the
shared `@time-travel-sql/sql-postgres` immutable `Sql` fragment builder. `Sql.query` accepts fragments only;
`Sql.identifier` validates and quotes qualified names, `Sql.literal` escapes text,
`Sql.integer` accepts exact safe integers, `Sql.parameter` builds bounded driver
placeholders, and `Sql.join` composes nonempty lists.
This keeps dynamic data out of SQL syntax and removes per-query escaping helpers.

Replication-capable connections require the simple query protocol, so these
statements render quoted literals instead of bound parameters. Ordinary PostgreSQL
and SQLite data queries retain driver-bound parameters. Static SQL remains readable
at its call site; the builder is not a schema validator or an execution abstraction.

Unit coverage rejects bare interpolation and malformed inputs. Native PostgreSQL
fixtures exercise setup and snapshot capture with quoted identifiers, including
apostrophes, backslashes and Unicode.

The historical query adapter uses the same builder for validated schema, type
modifiers, primary keys and column grants. Its loader binds all recorded values
with exact text serializers. The shared package depends only on SDK validation;
it never imports a source driver, connection or storage implementation.
