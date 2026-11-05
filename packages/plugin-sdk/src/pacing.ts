import type { StatusTruth, WorldJsonObject } from '@harness-world/contracts'
import type { SeamProvider } from './world.ts'

export type PacingIntensity = 'low' | 'medium' | 'high'
export interface PacingSource {
  readonly script: string
}
/** Something whose own conditions already hold. */
export interface PacingCandidate {
  readonly kind: 'activity' | 'beat'
  readonly key: string
}
/** Committed facts only, so a replay, a branch or a regenerated round reads the same history. */
export interface PacingHistory {
  readonly round: number
  readonly fired: readonly { readonly kind: 'activity' | 'beat'; readonly key: string; readonly round: number }[]
  /** Latest round each declared progress key changed or each declared activity ended. */
  readonly lastProgressRound: number
}
/** `reason` is for the creator's view only; it never reaches players or characters. */
export type PacingChoice =
  | { readonly kind: 'activity' | 'beat'; readonly key: string; readonly reason: WorldJsonObject }
  | { readonly kind: 'none'; readonly reason: WorldJsonObject }
/** What a beat script reads. Trusted: truth is complete, and nothing here is passed on to a character. */
export interface PacingBeatInput {
  readonly truth: StatusTruth
  readonly world: WorldJsonObject
}
/** Decides whether and what happens this round. Returns data: the host commits it after the core's checks. */
export interface PacingInstance {
  /** Activities whose start this mechanism decides; any other activity starts as it always has. */
  readonly managedActivities: readonly string[]
  readonly beats: readonly string[]
  /** Which status keys and activities count as real progress, for the host to read from committed events. */
  readonly progress: { readonly statuses: readonly string[]; readonly activities: readonly string[] }
  intensity(candidate: PacingCandidate): PacingIntensity
  /** The beat's own conditions, in the same shape as an activity's autoStart `when`. */
  checks(beatId: string, input: PacingBeatInput): unknown
  choose(input: {
    readonly candidates: readonly PacingCandidate[]
    readonly history: PacingHistory
    /** Recorded by the core; expires when this synchronous call returns. */
    readonly random: () => number
  }): PacingChoice
  apply(beatId: string, input: PacingBeatInput, random: () => number): unknown
  close?(): void | Promise<void>
}

export interface PacingSlotApi {
  register(provider: SeamProvider<PacingInstance>): () => void
  readonly current: SeamProvider<PacingInstance> | undefined
}
