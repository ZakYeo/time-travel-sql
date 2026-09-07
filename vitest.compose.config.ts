import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/compose/**/*.test.ts'],
    testTimeout: 180000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
