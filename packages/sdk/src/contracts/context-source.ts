import type { WorldHash, WorldJsonObject } from './world-json.ts'

/** The committed record a memory, cognition entry or projection was derived from. */
export interface ContextSourceRef extends WorldJsonObject {
  readonly sourceKind: string
  readonly sourceId: string
  readonly sourceSeq: number
  readonly sourceHash: WorldHash
}
