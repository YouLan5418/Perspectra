import { join } from 'node:path'
import type { WorldAddress } from '@harness-world/contracts'
import { createWorldReader } from '../../desktop/host/world-reader.ts'
import { CoreMemoryAdapter } from '../../packages/official-memory-core/src/core-memory.ts'

type Rest = ConstructorParameters<typeof CoreMemoryAdapter> extends [unknown, unknown, unknown, ...infer R] ? R : never

/** A Core adapter over one world directory, reading it the way the host does. */
export function coreAdapter(directory: string, address: WorldAddress, ...rest: Rest) {
  return new CoreMemoryAdapter(createWorldReader(join(directory, 'world.sqlite'), address), directory, address, ...rest)
}
