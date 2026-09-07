# Correctness contract

This document describes the required contract. Development evidence is tracked
separately; an unimplemented invariant is not a release guarantee.

## Identity and committed boundaries

Source identity, epoch, schema revision, relation ID, transaction identity and
event order are distinct. Positions are canonical unsigned source offsets encoded
as decimal strings. Postgres LSN conversion belongs in its adapter. Commit order
uses positions, never wall time or transaction IDs. Tied or backwards timestamps
must remain visible and cannot silently choose a unique transaction.

The baseline is a selectable state. Before a transaction means its predecessor;
after means the entire commit inclusively. Intra-transaction events are details,
not selectable externally committed states. Replay must be atomic even when a
later event fails. Duplicate inserts, missing predecessors, stale before-images
and key collisions are errors. Updates changing keys remove the old identity.

## Snapshot, durability and coverage

Bootstrap must import the snapshot exported by the newly created logical slot
into a repeatable-read transaction while the exporting replication connection
remains alive and has issued no subsequent command. Snapshot rows are staged in
bounded batches; baseline publication requires complete durable validation.
The stream begins at that slot's consistent position. Concurrent handoff tests
must prove no missing or double-applied commits.

Append all events and durable progress in one storage transaction. Acknowledge
only persisted progress. Identical redelivery is idempotent; divergent duplicates
are corruption. Restart validates identity and the retained slot, never silently
creates a replacement. Checkpoints must identify schema and position and agree
with authoritative baseline replay. Staging failures publish no partial state.

Lifecycle distinguishes bootstrapping, recording, stopped, interrupted and invalid
coverage. Stop retains resources for resume. Missing WAL, lost ownership, schema
changes and invalid progress bound the usable range explicitly.

## Exact values and schema

Versioned tagged values distinguish NULL, text (including empty), JSON null,
redacted data and byte strings. Unchanged TOAST is an adapter marker resolved
against recorded prior values, never against a current source query. Decimal,
int8, JSON numbers and microsecond timestamps never pass through JS number/Date.
Key encoding includes ordered typed components and relation identity.

The initial supported projection is explicit permanent tables with stable primary
keys (including composite keys), fixed schema and supported built-in scalar types.
Unsupported types, modifiers, generated columns, partitioning and schema changes
fail explicitly. No imported triggers, functions or executable source DDL replay.
Column policy is applied before persistence; unavailable identity keys are invalid.

## Investigation and isolation

Historical reconstruction uses recorded row values only. Query workspaces are
disposable, lack source connections and enforce read-only SQL in the engine.
Bound work, result rows/bytes and cancellation. Unavailable data cannot become NULL
to make a query succeed. Chronological invariant scans evaluate every selected
committed boundary, including the start; a predicate may fail, recover and fail.
Findings describe first observed violations, not application causality.

Portable import must validate bounded framing, integrity, references, values,
schema, order, keys and completeness before atomic publication. Cancellation and
corruption must leave existing recordings unchanged.
