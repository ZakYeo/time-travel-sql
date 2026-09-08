# Transaction context

`emitPostgresContext` is an optional helper for an explicitly chosen transaction.
It accepts a connected `pg` client that the caller is already using for that
transaction. It emits one transactional logical message using bound parameters.
It does not begin, commit, roll back, release or close the connection, change its
isolation level, intercept other queries, or replace their return values.

```ts
await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
try {
  await emitPostgresContext(client, {
    version: 1,
    operation: 'checkout.create',
    requestId: 'request-42',
  });
  // Execute the operation using this same connected client.
  await client.query('UPDATE items SET value=$1 WHERE id=$2', [2, 1]);
  await client.query('COMMIT');
} catch (failure) {
  try {
    await client.query('ROLLBACK');
  } catch (cleanup) {
    throw new AggregateError(
      [failure, cleanup],
      'Operation and rollback failed',
    );
  }
  throw failure;
}
// The caller still owns this client and any pool release.
```

Never pass a pool's convenience `query` method in place of the transaction's
connected client. Calling the helper outside an explicit transaction emits a
separate context-only commit; it cannot label a later write. This is an explicit
helper, not transparent instrumentation. Prisma integration and its checkout
sample remain separate unfinished work.

## Canonical data

SDK `TransactionContext` version 1 allows only these fields:

| Field       | Rule                                                    |
| ----------- | ------------------------------------------------------- |
| `operation` | Required, 1–128 ASCII identifier characters             |
| `requestId` | Optional, same bounded identifier rule                  |
| `traceId`   | Optional, 32 lowercase hexadecimal digits, not all zero |

Identifiers start with a letter or digit and then allow letters, digits, `.`, `_`,
`:` and `-`. Unknown fields, control characters, arbitrary nested objects and
accessors are rejected. No request bodies, SQL parameters or ambient context are
collected. Labels remain caller-supplied data; they are not authenticated identity
or proof of application causality. Do not put credentials in these explicit fields.

The PostgreSQL prefix is `tts.context.v1`; recognized payloads are limited to
1024 UTF-8 bytes and decoded with the same SDK policy. Exactly one recognized
transactional message may label a commit. Duplicate messages, malformed context,
nontransactional context or context outside a begin/commit envelope fail capture
without advancing durable progress. Other prefixes are ignored and their contents
are not persisted. Transport and transaction wire budgets still apply.

Context is attached to the enclosing committed transaction using protocol
boundaries, never timestamp matching or process-local association. Rollback,
including rollback to a savepoint, discards its transactional message. A commit
with only context has zero row events. Uninstrumented commits have no `context`
field; presentation should describe this as unavailable.

Ordinary export/import preserves context and includes it in transaction integrity
and duplicate validation. `export-derived` always omits context, and the canonical
decoder rejects context attached to a derived recording. Column policy alone does
not redact application labels in an ordinary recording. Malformed JSON diagnostics
omit parser causes that could quote payload bytes.

## Evidence and protocol references

Native tests exercise two committing connections in reverse emission order,
savepoint/full rollback, context-only commits, uninstrumented writes, caller
isolation, invalid input before SQL execution, unchanged aborted-transaction errors,
SQLite persistence and ordinary/derived portable import. Unit tests cover bounded
decoding, duplicate context and commit checks, ignored prefixes, wire budgets and
safe inspected errors. Browser context presentation and filtering remain pending.

PostgreSQL documents transactional emission in
[system administration functions](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-REPLICATION)
and the message flag/prefix/content fields in
[logical replication message formats](https://www.postgresql.org/docs/16/protocol-logicalrep-message-formats.html).
The adapter uses pgoutput protocol version 1 with logical messages enabled.
