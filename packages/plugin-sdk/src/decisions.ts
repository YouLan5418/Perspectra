import type { CharacterId, WorldJsonObject } from '@harness-world/contracts'
import type { MemoryRequest } from './memory.ts'
import type { SeamProvider } from './world.ts'

/** One way of taking part in every character decision. Everything is optional. */
export interface DecisionInstance {
  /** Exclude this prefix only when this instance delivers its archived memory. Without a hook, use the recent window. */
  shortTermAfterSeq?(characterId: CharacterId): number | undefined
  /** Add to what this character knows before it decides. Runs in the selected composition order. */
  context?<T extends MemoryRequest>(request: T, signal: AbortSignal): Promise<T>
  /** Wrap the whole decision. May call `next` several times, or not at all. The answer is validated afterwards. */
  decide?<T extends MemoryRequest>(
    request: T,
    next: (request: T) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<unknown>
  /** The host runs one character at a time and turns off follow-up publication while this is true. */
  readonly serial?: boolean
  /** Reports the head once when the world is ready, then on each refresh. It can skip commits and can repeat. */
  committed?(headSeq: number): void
  /** Merged into the state's debug section. */
  debug?(): WorldJsonObject
  close?(): void | Promise<void>
}
/** `ctx.decisions`: any number of implementations, applied in load order. Wrap `register` in `ctx.effect()`. */
export interface DecisionsApi {
  register(provider: SeamProvider<DecisionInstance>): () => void
  readonly providers: readonly SeamProvider<DecisionInstance>[]
}
