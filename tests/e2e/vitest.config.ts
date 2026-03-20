import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname + '/../..',
  test: {
    globals: true,
    testTimeout: 180_000,       // 3 min per test (k8s pod cold-start adds latency)
    hookTimeout: 600_000,       // 10 min for globalSetup (NATS init + k8s rollout)
    sequence: { concurrent: false },
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/mock-server/*.test.ts'],
    globalSetup: ['tests/e2e/global-setup.ts'],
  },
});
