# Architecture

The SDK owns deterministic identity, exact values, schema, transaction replay,
selection and differences. Domain modules import only domain code and language
primitives. Ports contain types only. Application services depend on those ports,
never adapters. Each external boundary validates unknown input before construction.

Node SQLite storage runs in owned workers. Reconstruction workers release their
read-only database snapshot before serving immutable selected rows. A Postgres adapter owns transport,
snapshot and stream lifecycle. A separate disposable PGlite worker owns historical
SQL. Neither driver nor runtime belongs in the SDK import graph. CLI composition
owns concrete adapters; browser components consume browser-safe HTTP contracts.

No ambient credentials, clocks, IDs, networking or side effects on SDK import.
Keep modules cohesive: review at 300 lines, split or justify before 500. Prefer
one canonical policy over repeated validation in adapters and views.
