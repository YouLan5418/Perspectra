import type { WorldJsonObject, WorldJsonValue } from './world-json.ts'

export type StatusValue = WorldJsonValue
export interface StatusChange {
  holderId: string | null
  key: string
  value: StatusValue
}
export interface StatusReveal {
  observerId: string
  holderId: string | null
  key: string
  value: StatusValue
}
export type StatusSource =
  | { kind: 'initial' }
  | { kind: 'operation'; operation: string; actorId: string; activityKey?: string }
  | { kind: 'activity'; activityKey: string; actorId: string }
  /** `pause` marks a round the player let pass without saying or doing anything. */
  | { kind: 'round'; round: number; pause?: true }
/** `description` is the author's result text for an operation; round and initial events have none. */
export interface StatusEventData {
  source: StatusSource
  changes: StatusChange[]
  reveals: StatusReveal[]
  description?: string
}
export interface StatusTruth {
  public: Record<string, StatusValue>
  characters: Record<string, Record<string, StatusValue>>
}
export interface KnownStatus {
  key: string
  label: string
  holderId: string | null
  value: StatusValue
  current: boolean
}
/** True value the author chose to hand to the player's frontend; never part of any character's context. */
export interface PlayerTruthStatus {
  key: string
  label: string
  holderId: string | null
  value: StatusValue
}

export interface StatusDefinition {
  readonly key: string
  readonly label: string
  readonly type: 'number' | 'string' | 'boolean' | 'object' | 'array' | 'null'
  readonly schema: WorldJsonObject
  readonly owner: 'public' | 'character'
  readonly alwaysKnown: boolean
  readonly activities?: readonly string[]
  /** Author opt-in: the true value is delivered to the player's frontend, which decides whether to show it. */
  readonly playerTruth: boolean
  /** Author opt-in: pinned to the player's status bar; every known status is in the status drawer anyway. */
  readonly bar: boolean
}
export interface StatusOperation {
  readonly id: string
  readonly label: string
  readonly schema: WorldJsonObject
  readonly characterParameters: readonly string[]
  readonly actors: 'player' | 'npc' | 'any'
  readonly activities?: readonly string[]
  /** The items this operation is done to; each one within reach is its own choice. Absent: the actor itself. */
  readonly targets?: readonly string[]
}

/** Bounds for the existing status and activity author scripts. */
export const SCRIPT_SOURCE_LIMIT = 256 * 1024
export const STATUS_CALL_LIMIT = 1024 * 1024
export const STATUS_VALUE_LIMIT = 16 * 1024
