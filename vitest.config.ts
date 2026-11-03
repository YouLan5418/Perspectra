import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@harness-world/interactions-basic': `${root}packages/interactions-basic/src/index.ts`,
      '@harness-world/provider-chat': `${root}packages/provider-chat/src/index.ts`,
      '@harness-world/interaction-runtime': `${root}packages/interaction-runtime/src/index.ts`,
      '@harness-world/agents': `${root}packages/agents/src/index.ts`,
      '@harness-world/application': `${root}packages/application/src/index.ts`,
      '@harness-world/contracts': `${root}packages/contracts/src/index.ts`,
      '@harness-world/frontend': `${root}packages/frontend/src/index.ts`,
      '@harness-world/plugin-sdk': `${root}packages/plugin-sdk/src/index.ts`,
      '@harness-world/official-scheduler': `${root}packages/official-scheduler/src/index.ts`,
      '@harness-world/official-jev-audit': `${root}packages/official-jev-audit/src/index.ts`,
      '@harness-world/official-llm': `${root}packages/official-llm/src/index.ts`,
      '@harness-world/official-memory-none': `${root}packages/official-memory-none/src/index.ts`,
      '@harness-world/official-memory-core': `${root}packages/official-memory-core/src/index.ts`,
      '@harness-world/kernel': `${root}packages/kernel/src/index.ts`,
      '@harness-world/memory': `${root}packages/memory/src/index.ts`,
      '@harness-world/presentation': `${root}packages/presentation/src/index.ts`,
      '@harness-world/runtime-cordis': `${root}packages/runtime-cordis/src/index.ts`,
      '@harness-world/store-sqlite': `${root}packages/store-sqlite/src/index.ts`,
      '@harness-world/testkit': `${root}packages/testkit/src/index.ts`,
      '@harness-world/world-pack': `${root}packages/world-pack/src/index.ts`,
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['tests/support/vitest-setup.ts'],
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    // Windows CI runs the SQLite integration suites substantially slower under
    // V8 coverage. Keep correctness deadlines inside the tests themselves and
    // give the test runner an explicit cross-platform wall-clock budget.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: [
        'packages/interactions-basic/src/**/*.ts',
        'packages/interaction-runtime/src/**/*.ts',
        'packages/agents/src/**/*.ts',
        'packages/application/src/**/*.ts',
        'packages/contracts/src/**/*.ts',
        'packages/kernel/src/**/*.ts',
        'packages/memory/src/**/*.ts',
        'packages/provider-chat/src/**/*.ts',
        'packages/presentation/src/**/*.ts',
        'packages/runtime-cordis/src/**/*.ts',
        'packages/store-sqlite/src/**/*.ts',
        'packages/world-pack/src/**/*.ts',
        'desktop/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/index.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
})
