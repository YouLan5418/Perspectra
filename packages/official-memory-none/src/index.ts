import type { MemoryInstance, SeamProvider } from '@harness-world/plugin-sdk'

/** Characters remember only the recent window the host always delivers. For offline work and tests: no
 * Python, no model calls, no long-term memory. */
export const officialMemoryNoneProvider: SeamProvider<MemoryInstance> = {
  id: 'official-memory-none',
  version: '1.0.0',
  open: async () => ({ project: async request => request }),
}
