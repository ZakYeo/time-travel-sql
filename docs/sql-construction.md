# SQL construction

Dynamic PostgreSQL snapshot, catalog and publication setup statements use the
adapter's immutable `Sql` fragment builder. `Sql.query` accepts fragments only;
`Sql.identifier` validates and quotes qualified names, `Sql.literal` escapes text,
`Sql.integer` accepts exact safe integers, and `Sql.join` composes nonempty lists.
This keeps dynamic data out of SQL syntax and removes per-query escaping helpers.

Replication-capable connections require the simple query protocol, so these
statements render quoted literals instead of bound parameters. Ordinary PostgreSQL
and SQLite data queries retain driver-bound parameters. Static SQL remains readable
at its call site; the builder is not a schema validator or an execution abstraction.

Unit coverage rejects bare interpolation and malformed inputs. Native PostgreSQL
fixtures exercise setup and snapshot capture with quoted identifiers, including
apostrophes, backslashes and Unicode.
