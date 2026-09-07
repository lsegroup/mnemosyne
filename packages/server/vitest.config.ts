import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // integration tests spawn git + a http server; keep them serial
    fileParallelism: false,
  },
});
