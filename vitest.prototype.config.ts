import { defineConfig } from 'vitest/config'
import config from './vitest.config.ts'

// Baseline smoke tests. Replace these with current behavior tests as the prototype evolves.
export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: [
      'packages/store-sqlite/src/character-view.test.ts',
      'packages/world-pack/src/compiler-v5.test.ts',
      'tests/prototype/**/*.test.ts',
    ],
  },
})
