import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/agent/src/**/*.test.ts',
      // Pure logic from the web client (no DOM needed).
      'apps/web/src/lib/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 20_000,
  },
});
