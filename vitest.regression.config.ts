import { defineConfig } from 'vitest/config'
import config from './vitest.config.ts'

// Default regression: every package unit test plus host, launcher backend, gameplay scenarios and
// cross-package integration. Only tests/experiments stays out (see tests/support/README.md).
export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: [
      'packages/**/*.test.ts',
      'tests/host/**/*.test.ts',
      'tests/desktop/**/*.test.ts',
      'tests/scenarios/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
  },
})
