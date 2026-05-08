import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'gui/**/*.test.ts', 'cli/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
