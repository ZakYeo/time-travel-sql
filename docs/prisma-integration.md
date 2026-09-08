# Prisma PostgreSQL integration

`@time-travel-sql/integration-prisma` provides `emitPrismaContext` for an explicit
interactive transaction. It is tested with Prisma, Prisma Client and the PostgreSQL
driver adapter pinned to 7.10.0. The integration uses only public tagged
`$executeRaw` calls and the shared bounded PostgreSQL context encoder. The SDK has
no Prisma dependency or generated-model import. Importing the integration does not
load a generated client, connect, generate code or modify global state.

```ts
import { emitPrismaContext } from '@time-travel-sql/integration-prisma';

const result = await prisma.$transaction(
  async (transaction) => {
    await emitPrismaContext(transaction, {
      version: 1,
      operation: 'checkout.create',
      requestId: 'request-42',
    });
    return transaction.order.create({ data: { id: 'order-42', total: 199 } });
  },
  { isolationLevel: 'Serializable' },
);
```

Use the `transaction` argument, not the root client. The helper rejects a root
client's public `$connect` surface at both type and runtime boundaries. Prisma
7.10 transaction clients retain `$transaction`, so that member cannot distinguish
the two. This structural guard prevents ordinary accidental misuse; it does not
authenticate arbitrary proxies or casts.

The caller chooses transaction boundaries, isolation, timeout and pool ownership.
The helper does not install an extension, intercept queries, begin another
transaction, change the operation's return value, or catch its failures. PostgreSQL
rollback also discards the emitted context. One context message is supported per
transaction. Do not emit additional contexts in nested operations on that same
transaction. Uninstrumented nested writes and batch transactions remain recordable,
with context unavailable. No universal transparent instrumentation is promised.

Context fields and limits are defined in [transaction context](transaction-context.md).
Ordinary portable recordings preserve context; derived sharing exports omit it.
Application labels describe recorded association and do not prove causality.

## Checkout example and validation

[The checkout example](../examples/checkout/README.md) includes a Prisma schema,
inspectable SQL schema, typed Prisma nested writes and equivalent plain SQL writes.
It intentionally omits quantity when calculating the order total. Native tests
record both clients through the same PostgreSQL source and SQLite APIs, then use
historical SQL to find the first observed total mismatch with its recorded context.

`npm run typecheck` generates the client into ignored `artifacts/prisma/client`
and compiles both examples against its actual public types. Generated third-party
code is outside production packages and repository-owned lint/architecture scans.
The architecture checker still checks the example's own imports and the integration
package. Generation needs no database or ambient credentials; update checks are
disabled. It is tooling work, never an import-time library side effect.

The native suite also installs four locally packed packages into a temporary,
isolated consumer with disabled install scripts. Dependency setup may contact the
npm registry; this is not an offline-install proof. That consumer
generates and compiles its own Prisma client, performs a checkout and rollback,
and captures the emitted context against an owned PostgreSQL cluster. It imports
application libraries from the installed tarballs. Its compiler and generator are
installed dependencies too. Nothing is published.

For a nondefault local npm cache, set `TTS_NPM_CACHE` when running the native
consumer test. Cached dependencies are preferred; missing metadata or packages are fetched during
consumer setup.
The [bundled CLI sample](bundled-sample.md) is available. Browser presentation,
onboarding and broader application acceptance remain unfinished; these tests prove the integration and checkout path.

Public API references:
[interactive transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions),
[raw queries](https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/raw-queries),
and [client generation](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators).
