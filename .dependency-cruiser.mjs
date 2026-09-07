import { existsSync, readdirSync } from 'node:fs';

const roots = ['packages', 'apps'].flatMap((root) =>
  existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${root}/${entry.name}`)
    : [],
);

export default {
  forbidden: [
    ...roots.map((root) => ({
      name: `public-imports-only-${root.replace('/', '-')}`,
      severity: 'error',
      from: { pathNot: `^${root}/` },
      to: { path: `^${root}/`, dependencyTypes: ['local', 'localmodule'] },
    })),
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-unresolved',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      from: { path: '^packages/sdk/src/domain/' },
      to: { pathNot: '^packages/sdk/src/domain/' },
    },
    {
      name: 'ports-only-contracts',
      severity: 'error',
      from: { path: '^packages/sdk/src/ports/' },
      to: { pathNot: '^packages/sdk/src/(domain|ports)/' },
    },
    {
      name: 'sdk-is-independent',
      severity: 'error',
      from: { path: '^packages/sdk/src/' },
      to: { pathNot: '^packages/sdk/src/' },
    },
    {
      name: 'adapters-not-composition',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'browser-not-node',
      severity: 'error',
      from: { path: '^apps/web/src/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'browser-runtime-allowlist',
      severity: 'error',
      from: { path: '^apps/web/src/' },
      to: {
        path: 'node_modules/',
        pathNot: 'node_modules/(preact/|@time-travel-sql/(sdk|contracts)/)',
      },
    },
    {
      name: 'browser-not-adapters',
      severity: 'error',
      from: { path: '^apps/web/src/' },
      to: {
        path: '^(packages/(storage-|source-|query-|integration-)|apps/cli/)',
      },
    },
    {
      name: 'production-not-tests',
      severity: 'error',
      from: { path: '^(packages|apps)/.*/src/' },
      to: { path: '(^test/|^test-support/|^examples/|\\.test\\.)' },
    },
  ],
  options: {
    enhancedResolveOptions: {
      conditionNames: ['import', 'types', 'node', 'default'],
      exportsFields: ['exports'],
    },
    doNotFollow: { path: '(node_modules|/dist/)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
  },
};
