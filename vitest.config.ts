import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@perspectra\/host\/play-settings$/,
        replacement: fileURLToPath(new URL('./apps/host/src/play-settings.ts', import.meta.url)),
      },
      {
        find: /^@perspectra\/host\/plugin-settings$/,
        replacement: fileURLToPath(new URL('./apps/host/src/host-plugin-settings.ts', import.meta.url)),
      },
      { find: /^@perspectra\/core$/, replacement: `${root}packages/core/src/application/index.ts` },
      { find: /^@perspectra\/core\/agents$/, replacement: `${root}packages/core/src/agents/index.ts` },
      { find: /^@perspectra\/core\/interactions$/, replacement: `${root}packages/core/src/interactions/index.ts` },
      { find: /^@perspectra\/core\/kernel$/, replacement: `${root}packages/core/src/kernel/index.ts` },
      { find: /^@perspectra\/core\/memory$/, replacement: `${root}packages/core/src/memory/index.ts` },
      { find: /^@perspectra\/core\/presentation$/, replacement: `${root}packages/core/src/presentation/index.ts` },
      { find: /^@perspectra\/core\/runtime$/, replacement: `${root}packages/core/src/runtime/index.ts` },
      { find: /^@perspectra\/core\/store$/, replacement: `${root}packages/core/src/store/index.ts` },
      { find: /^@perspectra\/frontend$/, replacement: `${root}packages/frontend/src/index.ts` },
      { find: /^@perspectra\/jev-audit$/, replacement: `${root}packages/jev-audit/src/index.ts` },
      { find: /^@perspectra\/memory-core$/, replacement: `${root}packages/memory-core/src/index.ts` },
      {
        find: /^@perspectra\/plugins\/world-events$/,
        replacement: `${root}packages/plugins/src/world-events/index.ts`,
      },
      { find: /^@perspectra\/plugins\/dice$/, replacement: `${root}packages/plugins/src/dice/index.ts` },
      { find: /^@perspectra\/plugins\/pacing$/, replacement: `${root}packages/plugins/src/pacing/index.ts` },
      { find: /^@perspectra\/plugins\/rpg$/, replacement: `${root}packages/plugins/src/rpg/index.ts` },
      { find: /^@perspectra\/plugins\/trpg$/, replacement: `${root}packages/plugins/src/trpg/index.ts` },
      {
        find: /^@perspectra\/providers\/activities$/,
        replacement: `${root}packages/providers/src/activities/index.ts`,
      },
      {
        find: /^@perspectra\/providers\/character-loop$/,
        replacement: `${root}packages/providers/src/character-loop/index.ts`,
      },
      { find: /^@perspectra\/providers\/chat$/, replacement: `${root}packages/providers/src/chat/index.ts` },
      { find: /^@perspectra\/providers\/chat\/preset$/, replacement: `${root}packages/providers/src/chat/preset.ts` },
      {
        find: /^@perspectra\/providers\/chat\/preset-library$/,
        replacement: `${root}packages/providers/src/chat/preset-library.ts`,
      },
      {
        find: /^@perspectra\/providers\/chat\/preset-macros$/,
        replacement: `${root}packages/providers/src/chat/preset-macros.ts`,
      },
      {
        find: /^@perspectra\/providers\/chat\/preset-regex$/,
        replacement: `${root}packages/providers/src/chat/preset-regex.ts`,
      },
      {
        find: /^@perspectra\/providers\/chat\/prompt-cache$/,
        replacement: `${root}packages/providers/src/chat/prompt-cache.ts`,
      },
      {
        find: /^@perspectra\/providers\/communication$/,
        replacement: `${root}packages/providers/src/communication/index.ts`,
      },
      { find: /^@perspectra\/providers\/contexts$/, replacement: `${root}packages/providers/src/contexts/index.ts` },
      { find: /^@perspectra\/providers\/knowledge$/, replacement: `${root}packages/providers/src/knowledge/index.ts` },
      { find: /^@perspectra\/providers\/llm$/, replacement: `${root}packages/providers/src/llm/index.ts` },
      {
        find: /^@perspectra\/providers\/memory-none$/,
        replacement: `${root}packages/providers/src/memory-none/index.ts`,
      },
      { find: /^@perspectra\/providers\/scheduler$/, replacement: `${root}packages/providers/src/scheduler/index.ts` },
      {
        find: /^@perspectra\/providers\/scripted-model$/,
        replacement: `${root}packages/providers/src/scripted-model/index.ts`,
      },
      { find: /^@perspectra\/providers\/status$/, replacement: `${root}packages/providers/src/status/index.ts` },
      { find: /^@perspectra\/sdk$/, replacement: `${root}packages/sdk/src/index.ts` },
      { find: /^@perspectra\/sdk\/contracts$/, replacement: `${root}packages/sdk/src/contracts/index.ts` },
      { find: /^@perspectra\/testkit$/, replacement: `${root}packages/testkit/src/index.ts` },
      { find: /^@perspectra\/world-pack$/, replacement: `${root}packages/world-pack/src/index.ts` },
      { find: /^@perspectra\/world-pack\/cli$/, replacement: `${root}packages/world-pack/src/creator-cli.ts` },
      { find: /^@perspectra\/world-pack\/lens\/diff$/, replacement: `${root}packages/world-pack/src/lens/diff.ts` },
      { find: /^@perspectra\/world-pack\/lens\/ids$/, replacement: `${root}packages/world-pack/src/lens/ids.ts` },
      {
        find: /^@perspectra\/world-pack\/lens\/rpg-view$/,
        replacement: `${root}packages/world-pack/src/lens/rpg-view.ts`,
      },
      { find: /^@perspectra\/world-pack\/lens\/view$/, replacement: `${root}packages/world-pack/src/lens/view.ts` },
    ],
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
        'packages/core/src/interactions/**/*.ts',
        'packages/core/src/agents/**/*.ts',
        'packages/core/src/application/**/*.ts',
        'packages/sdk/src/contracts/**/*.ts',
        'packages/core/src/kernel/**/*.ts',
        'packages/core/src/memory/**/*.ts',
        'packages/providers/src/chat/**/*.ts',
        'packages/core/src/presentation/**/*.ts',
        'packages/core/src/runtime/**/*.ts',
        'packages/core/src/store/**/*.ts',
        'packages/world-pack/src/**/*.ts',
        'apps/host/src/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/index.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
})
