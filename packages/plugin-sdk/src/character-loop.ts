import type { CharacterId, WorldJsonObject } from '@harness-world/contracts'
import type { SeamProvider } from './world.ts'

export interface CharacterLoopRequest {
  readonly decisionId?: string
  readonly context: WorldJsonObject
  readonly continuation: boolean
  readonly canPerform?: boolean
  readonly result?: WorldJsonObject
  readonly canContinueAfterPublish?: boolean
  readonly afterPublication?: boolean
  readonly canExpressBeforeAction?: boolean
}

export type CharacterLoopStatus = 'published' | 'abstained' | 'budget_exhausted' | 'failed'

export interface CharacterLoopPreparation {
  readonly continuation: boolean
  readonly canPerform: boolean
  readonly canContinueAfterPublish?: boolean
  readonly afterPublication?: boolean
}

export interface CharacterLoopSubmission {
  readonly decision: 'publish' | 'perform' | 'abstain'
  readonly status: 'accepted' | 'rejected'
  readonly controlledCommitted: boolean
  readonly publicationRejected: boolean
}

/** Bound to one NPC activation. Requests/results are copies; no caller-supplied actor or world prefix. */
export interface CharacterLoopActivation {
  readonly characterId: CharacterId
  readonly signal: AbortSignal
  readonly maxCalls: 1 | 2 | 3
  readonly maxModelCalls: number
  readonly continuation: boolean
  readonly continueAfterPublish: boolean
  readonly calls: number
  readonly performResult: WorldJsonObject | undefined
  prepare(options: CharacterLoopPreparation): CharacterLoopRequest
  decide(reserveFormatRetry?: () => boolean): Promise<unknown>
  submit(decision: unknown): Promise<CharacterLoopSubmission>
}

export interface CharacterLoopInstance {
  run(activation: CharacterLoopActivation): Promise<CharacterLoopStatus>
  close?(): void | Promise<void>
}

/** One loop per world, shared by its activations. Keep activation state inside run, not on the instance. */
export interface CharacterLoopSlotApi {
  register(provider: SeamProvider<CharacterLoopInstance>): () => void
  readonly current: SeamProvider<CharacterLoopInstance> | undefined
}
