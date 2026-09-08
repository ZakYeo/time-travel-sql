import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  {
    ignores: [
      '**/dist/**',
      'node_modules/**',
      'artifacts/**',
      'test/semgrep/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['packages/sdk/src/ports/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Program > :not(TSInterfaceDeclaration):not(TSTypeAliasDeclaration):not(ImportDeclaration[importKind='type']):not(ExportNamedDeclaration[exportKind='type'])",
          message:
            'Ports contain type-only contracts, never runtime imports or executable policy.',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
      },
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: { module: 'readonly', require: 'readonly' } },
  },
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
