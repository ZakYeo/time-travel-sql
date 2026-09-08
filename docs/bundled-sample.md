# Bundled checkout sample

After installing the pinned Node version and running `npm ci` and `npm run build`:

```sh
npm run tts -- sample --workspace ./artifacts/workspace
npm run tts -- inspect sample-checkout-v1 --workspace ./artifacts/workspace
```

`sample` creates the workspace if necessary, then imports the packaged portable
recording through the same validation and atomic publication path as other files.
It needs no PostgreSQL server, Prisma generation, credentials or network access.
The CLI package includes the asset; loading does not depend on the current directory
or a repository checkout. Dependency installation is a separate setup step.

This is synthetic teaching data, labelled `Sample: checkout totals`, with source
`sample-checkout` and epoch `sample-v1`. Its fixed ID is `sample-checkout-v1`.
It models the intentional quantity/total bug in the
[Prisma and plain SQL checkout examples](../examples/checkout/README.md).
It does not claim to be a live database capture. It is stopped, complete within its
recorded range, and has no live source binding. It cannot be resumed against a source.

| Position     | Recorded change                                               |
| ------------ | ------------------------------------------------------------- |
| 0 (baseline) | Ten units of coffee in inventory, priced at 199 each          |
| 10           | `order-1`: one unit, total 199; stock becomes 9               |
| 20           | `order-2`: two units, incorrect total 199; stock becomes 7    |
| 30           | Correct `order-2` total to 398                                |
| 40           | Cancel `order-1`, remove its line item and restore stock to 8 |

Each transaction carries an explicit sample operation and request ID. Positions
are whole committed boundaries. A query at position 20 still shows the incorrect
total after the correction at 30. This query returns the mismatching order:

```sh
npm run tts -- query sample-checkout-v1 after:20 \
  'SELECT o.id FROM orders o JOIN line_items l ON l."orderId"=o.id GROUP BY o.id,o.total HAVING o.total <> sum(l.quantity*l."unitPrice")' \
  --workspace ./artifacts/workspace --json
```

The same query returns no rows at `before:20` and `after:30`. Use `save-check` and
`scan-check` to find the first observed violation across `baseline` to `after:40`;
see [saved checks](invariant-scans.md). Row inspection, transaction details, comparison,
export and import all use the ordinary recording commands. Exporting and importing
into another workspace preserves positions and historical results.

Loading again fails if that ID exists, including after a local rename. It does
not overwrite the existing recording or reset an investigation. Use the existing
recording, or explicitly remove it before loading a fresh copy. No failure in
another recording ever silently selects or loads this sample.

## Maintainer reproduction

`scripts/generate-checkout-sample.mjs` defines the data and writes it through real
SQLite storage and the public portable exporter in an owned temporary workspace.
It never connects to a source. After building the packages:

```sh
node scripts/generate-checkout-sample.mjs --check
node scripts/generate-checkout-sample.mjs
```

The first command validates byte-for-byte reproducibility without changing the
asset. The second explicitly regenerates `apps/cli/assets/checkout.tts`. Unit tests
check reproduction and the package file list. The CLI journey test executes real
historical queries, finds the first violation and repeats the query after export,
local deletion and import into an independent workspace.

Browser onboarding and the local HTTP application remain unfinished. This sample
is available through the implemented CLI today and provides data for those journeys.
