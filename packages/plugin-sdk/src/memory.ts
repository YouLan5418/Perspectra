import type { CharacterId, WorldJsonObject } from '@harness-world/contracts'
import type { SeamProvider } from './world.ts'

/** What a memory implementation is handed of one character decision. */
export interface MemoryRequest {
  readonly context: WorldJsonObject
  readonly decisionId?: string
}
/** Long-term memory for characters. Only `project` is required: it returns the request a character decides on,
 * and what it adds is that character's to know. Everything else is optional; the host treats a missing method
 * as nothing to do, and a save restored without archives simply starts from the recent window. */
export interface MemoryInstance {
  project<T extends MemoryRequest>(request: T, signal: AbortSignal): Promise<T>
  observeContext?(request: MemoryRequest, promptText: string): void
  recordDecision?(request: MemoryRequest, response: unknown): void
  /** The sequence up to which this memory has taken over; the recent window starts after it. */
  shortTermAfterSeq?(characterId: CharacterId): number
  startPending?(): void
  cancelBackground?(): void
  waitForBackground?(): Promise<void>
  backgroundState?(): WorldJsonObject
  startRefresh?(characterIds: readonly CharacterId[]): void
  inspect?(characterId: string, offset: number, limit: number): WorldJsonObject | undefined
  snapshotAliases?(characterIds: readonly CharacterId[]): WorldJsonObject
  snapshotArchives?(characterIds: readonly CharacterId[]): WorldJsonObject
  restoreArchives?(archives: WorldJsonObject, characterIds: readonly CharacterId[]): void
  holdInstallation?(): void
  releaseInstallation?(): void
  close?(): void | Promise<void>
}
/** `ctx.memory`: replaces the characters' long-term memory. Wrap `register` in `ctx.effect()`. */
export interface MemorySlotApi {
  /** Throws when another plugin already holds the seam. */
  register(provider: SeamProvider<MemoryInstance>): () => void
  readonly current: SeamProvider<MemoryInstance> | undefined
}
