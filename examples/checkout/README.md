# Recorded checkout example

This example models inventory, orders and line items. It contains an intentional
bug: an order with quantity 2 and unit price 199 records total 199 instead of 398.
Both clients perform the same faulty domain operation so the debugger can expose
the first recorded mismatch.

- `schema.prisma` defines the actual generated Prisma 7.10 client.
- `schema.sql` is inspectable PostgreSQL DDL for this isolated example.
- `prisma-checkout.ts` uses an explicit serializable transaction, emits bounded
  context, creates an order with nested line items, updates inventory and returns
  the actual Prisma result.
- `plain-checkout.ts` performs equivalent writes on the caller's existing
  transaction connection. Its caller owns begin/commit/rollback and connection
  release.

Run the real disposable example test:

```sh
npm run test:integration -- test/integration/prisma-checkout.test.ts
```

The test creates its own native PostgreSQL cluster, generates the client, captures
baseline and commits into SQLite, tests rollback and uninstrumented writes, and
executes this invariant chronologically on historical reconstructed states:

```sql
SELECT o.id
FROM orders o JOIN line_items l ON l."orderId" = o.id
GROUP BY o.id, o.total
HAVING o.total <> sum(l.quantity * l."unitPrice")
```

The first observed violation is the instrumented Prisma checkout. The plain SQL
checkout has the equivalent incorrect total. A later batch corrects the Prisma
order, demonstrating that finding the first violation requires chronological
inspection rather than checking only the final state.

The test uses no ambient `DATABASE_URL`, user database or credentials and deletes
only its own temporary resources. The SQL schema is for the isolated example;
applying it elsewhere is an explicit operator action. This is a reproducible
debugging example, not a production checkout implementation. Browser integration
and persistent bundled sample loading remain unfinished.
