import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/query-policy/**/*.test.ts'],
    testTimeout: 30000,
    maxWorkers: 1,
  },
});
