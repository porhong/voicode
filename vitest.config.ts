import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/agent/src/**/*.test.ts',
      // Web client logic and components rendered to static markup (no DOM needed).
      'apps/web/src/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 20_000,
  },
});
