import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@harness-world/agents': `${root}packages/agents/src/index.ts`,
      '@harness-world/application': `${root}packages/application/src/index.ts`,
      '@harness-world/contracts': `${root}packages/contracts/src/index.ts`,
      '@harness-world/kernel': `${root}packages/kernel/src/index.ts`,
      '@harness-world/memory': `${root}packages/memory/src/index.ts`,
      '@harness-world/operations': `${root}packages/operations/src/index.ts`,
      '@harness-world/presentation': `${root}packages/presentation/src/index.ts`,
      '@harness-world/runtime-cordis': `${root}packages/runtime-cordis/src/index.ts`,
      '@harness-world/store-sqlite': `${root}packages/store-sqlite/src/index.ts`,
      '@harness-world/simulation': `${root}packages/simulation/src/index.ts`,
      '@harness-world/testkit': `${root}packages/testkit/src/index.ts`,
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/agents/src/**/*.ts',
        'packages/application/src/**/*.ts',
        'packages/contracts/src/**/*.ts',
        'packages/kernel/src/**/*.ts',
        'packages/memory/src/**/*.ts',
        'packages/operations/src/**/*.ts',
        'packages/presentation/src/**/*.ts',
        'packages/runtime-cordis/src/**/*.ts',
        'packages/store-sqlite/src/**/*.ts',
        'packages/simulation/src/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: ['text', 'json-summary'],
    },
  },
})
