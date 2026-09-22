import { defineConfig } from 'vitest/config'
import config from './vitest.config.ts'

// Baseline smoke tests. Replace these with current behavior tests as the prototype evolves.
export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: [
      'packages/store-sqlite/src/character-view.test.ts',
      'packages/kernel/src/interactions.test.ts',
      'tests/prototype/**/*.test.ts',
    ],
  },
})
