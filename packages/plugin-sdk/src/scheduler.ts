import type { CharacterId, WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { WorldReader, SeamProvider } from './world.ts'

/** The player's settings. Advisory for a plugin: the host does not cap what it spends. */
export interface ActivationLimits {
  readonly maximumWaves: number
  readonly maximumNpcCalls: number
  readonly maximumCallsPerCharacter: number
  readonly reactionDeadlineSeconds?: number
}
export interface AutonomyOpportunities {
  /** Official measurement preference; another scheduler may choose its own interleaving. */
  readonly staged?: boolean
  readonly roles: readonly { readonly characterId: CharacterId; readonly opportunities: number }[]
  readonly maximumNpcCalls: number
  readonly deadlineSeconds: number
  readonly reactionLimits: ActivationLimits
}
export interface SchedulerObservation {
  readonly seq: number
  readonly characterId: CharacterId
  /** False when this observer only saw a silent performance not addressed to them. */
  readonly substantive: boolean
}
export interface SchedulerTurnOptions {
  readonly kind?: 'reaction' | 'autonomous'
  readonly signal: AbortSignal
  /** Must belong to this character; the host fetches their content. */
  readonly stimulusSeqs: readonly number[]
  readonly maxCalls: 1 | 2 | 3
  readonly maxModelCalls?: number
  /** Optional scheduler-owned budget, invoked immediately before each actual model send, including retries. */
  readonly beforeModelCall?: () => void
  readonly onCommitted?: (asOfWorldSeq: number, headSeq: number) => void
  /** After a stale result: continue an action that already committed instead of repeating it. */
  readonly continuationOf?: {
    readonly actionId: string
    readonly afterSeq?: number
    readonly action: { readonly actionType: string; readonly parameters: WorldJsonValue }
  }
}
export interface SchedulerTurnResult {
  readonly status: 'published' | 'abstained' | 'budget_exhausted' | 'interrupted' | 'inactive' | 'stale' | 'failed'
  readonly calls: number
  readonly asOfWorldSeq?: number
  readonly performResult?: WorldJsonObject
  readonly failure?: 'provider_failed' | 'invalid_output' | 'preset_failed'
}
export interface SchedulerRound {
  readonly phase: 'scene' | 'autonomy' | 'activity'
  readonly characterIds: readonly CharacterId[]
  readonly afterSeq: number
  readonly signal: AbortSignal
  readonly limits: ActivationLimits
  /** False while the current play requires characters to be handled one at a time. */
  readonly allowConcurrent: boolean
  readonly initialCounts?: ReadonlyMap<CharacterId, number>
  readonly autonomy?: AutonomyOpportunities
  readonly activity?: {
    readonly opportunities: number
    readonly deadlineSeconds: number
    /** The legal next participant, updated by the host after each real turn result. */
    next(): CharacterId | undefined
    resultUnknown(): boolean
  }
  readonly world: WorldReader
  headSeq(): number
  /** Accepted observations of someone else's action, in commit order. */
  observationsSince(afterSeq: number, throughSeq: number): readonly SchedulerObservation[]
  /** All observations in this character's authorized view, without the reaction-only substantive filter. */
  observationSeqs(characterId: CharacterId, afterSeq: number, throughSeq: number): readonly number[]
  presentCharacterIds(): readonly CharacterId[]
  locationOf(id: CharacterId): string | null
  /** Give one character an opportunity. Facts still commit through the host's normal checks. */
  turn(id: CharacterId, options: SchedulerTurnOptions): Promise<SchedulerTurnResult>
}
export interface SchedulerActivation {
  readonly characterId: CharacterId
  readonly result: SchedulerTurnResult
}
export interface SchedulerCycle {
  readonly calls: number
  readonly wave: number
  /** `failed`, `interrupted`, `call_limit`, `wave_limit` and `character_limit` have their own player notices. */
  readonly terminalReason: string
  readonly activations: readonly SchedulerActivation[]
}
export interface SchedulerResult extends SchedulerCycle {
  readonly autonomy?: {
    readonly activations: readonly SchedulerActivation[]
    readonly autonomousCalls: number
    readonly reactionCalls: number
    readonly reactions?: SchedulerCycle
    readonly terminalReason: string
  }
}
export interface SchedulerInstance {
  run(round: SchedulerRound): Promise<SchedulerResult>
  close?(): void | Promise<void>
}
/** `ctx.scheduler`: decides who gets an opportunity and when. Wrap `register` in `ctx.effect()`. */
export interface SchedulerSlotApi {
  /** Throws when another plugin already holds the seam. */
  register(provider: SeamProvider<SchedulerInstance>): () => void
  readonly current: SeamProvider<SchedulerInstance> | undefined
}
