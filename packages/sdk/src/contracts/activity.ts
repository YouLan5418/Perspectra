import type { WorldJsonObject } from './world-json.ts'

export type ActivityGame = WorldJsonObject & {
  active: boolean
  phase: string
  turn: string | null
  round: number
  public: WorldJsonObject
  private: WorldJsonObject
  internal: WorldJsonObject
}
export type ActivityState = WorldJsonObject & {
  id: string
  revision: number
  participants: string[]
  game: ActivityGame
  suspendedTurn?: string
}

export type ActivityPolicy = WorldJsonObject & {
  speech: 'free' | 'none' | 'choices'
  speechChoices: string[]
  narration: boolean
  move: boolean
  interactions: string[]
  operations: string[]
}
export type ActivityOperation = {
  id: string
  label: string
  requiresTurn: boolean
  schema: WorldJsonObject
  quick: boolean
}
export interface ActivityRequest {
  readonly activityKey?: string
  readonly activityId: string | null
  readonly revision: number
  readonly operation: string
  readonly parameters: WorldJsonObject
  readonly requestId: string
}
/** One autoStart condition as the author wrote it; the label only names it for the pack lens. */
export interface AutoStartCheck {
  readonly label: string | null
  readonly met: boolean
}
/** One activity's automatic-start checks for the pack lens; null checks: not checked this time, see `skipped`. */
export interface AutoStartEvaluation {
  readonly activityKey: string
  readonly title: string
  readonly checks: readonly AutoStartCheck[] | null
  readonly started: boolean
  /** Why checks are null without an error: an activity runs in the foreground, this one holds paused progress,
   * or its hook returned null. */
  readonly skipped?: 'running' | 'paused' | 'none'
  /** The hook's failure message; a round still throws it, evaluation only reports it. */
  readonly error?: string
}

/** One activity as the author declared it, for the pack lens. */
export interface ActivityDefinitionView {
  readonly activityKey: string
  readonly title: string
  readonly opening: string | undefined
  readonly npcIds: readonly string[]
  readonly participantSelection:
    | { readonly min: number; readonly max: number; readonly candidates?: string[] }
    | undefined
  readonly hasAutoStart: boolean
  readonly operations: readonly { readonly id: string; readonly label: string }[]
}
