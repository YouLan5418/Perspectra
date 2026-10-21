import { defineConfig } from 'vitest/config'
import config from './vitest.config.ts'

// Default regression: current host, launcher backend, gameplay scenarios and cross-package integration.
// `test:related` (vitest.config.ts) additionally runs every package unit test.
export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: [
      'packages/store-sqlite/src/character-view.test.ts',
      'packages/world-pack/src/compiler-v5.test.ts',
      'tests/host/**/*.test.ts',
      'tests/desktop/**/*.test.ts',
      'tests/scenarios/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
  },
})
