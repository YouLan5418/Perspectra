import type {
  AutoStartCheck,
  CharacterView,
  StoredWorldEvent,
  WorldAddress,
  WorldJsonObject,
} from '@perspectra/sdk/contracts'
import type { EventRule, PacingCandidate, PacingChoice } from '@perspectra/sdk'
import type { InspectedRequest } from '@perspectra/providers/chat'

/** Host-only read API. No paths, provider configuration or arbitrary commands accepted. */
export interface CreatorInspectionQuery {
  characterId?: string
  afterSeq?: number
  limit?: number
  memoryOffset?: number
}
export interface EventRuleCheck {
  seq: number
  round: number
  result: 'round' | 'clock' | 'clock-invalid' | 'clock-window' | 'activity' | 'ready'
}
export interface InspectedEventRule {
  rule: EventRule
  lastCheck: EventRuleCheck | null
  occurrence: {
    id: string
    seq: number
    cycle: string
    pacedRound: number | null
    clockTransaction: string | null
    witnesses: { id: string; seq: number; notice: string; wake: 'pending' | 'claimed' | 'completed' | null }[]
    deliveries: { plugin: string; mode: 'live' | 'durable'; receipt: boolean }[]
  } | null
}
export interface InspectedPacingDecision {
  id: number
  cycle: string
  seq: number
  round: number
  busy: boolean
  candidates: readonly PacingCandidate[] | null
  beats: { id: string; checks: readonly AutoStartCheck[]; error?: string }[]
  choice: PacingChoice | null
  occurrenceId?: string
  skipped?: 'activity-in-progress' | 'unmanaged-activity'
  priorityActivity?: string
  lastFired?: PacingCandidate & { round: number }
  lastProgressRound?: number
  error?: string
}
export interface CreatorInspectionSnapshot {
  capturedAt: string
  address: WorldAddress
  worldVersion: string
  title: string
  headSeq: number
  tick: number
  packHash: string
  storyParentNodeId: string | null
  busy: boolean
  paused: boolean
  captureEnabled: boolean
  characters: {
    id: string
    name: string
    locationId: string | null
    locationName: string | null
    sceneIds: string[]
    lifecycle: string
    lastMovementSeq: number | null
    processing: { transport: string; lastActivation: unknown }
  }[]
  entities: {
    id: string
    name: string
    state: WorldJsonObject
    holderMeaning: 'custody'
    effectiveLocationId: string | null
    locationBasis: 'entity' | 'holder' | 'unknown'
    lastChangeSeq: number
  }[]
  /** Why the last round did or did not bring an event. */
  pacing: WorldJsonObject | null
  pacingDiagnostics: { enabled: boolean; managedEvents: readonly string[]; decisions: InspectedPacingDecision[] } | null
  worldEvents: InspectedEventRule[]
  statusOperations: {
    limit: number
    operations: { id: string; label: string; actors: 'player' | 'npc' | 'any'; offeredToPlayer: boolean }[]
    policyErrors: Record<string, string>
  } | null
  statusTruth: { public: WorldJsonObject; characters: Record<string, WorldJsonObject> } | null
  activities: WorldJsonObject[]
  events: { items: StoredWorldEvent[]; nextAfterSeq: number; hasMore: boolean }
  character?: {
    id: string
    currentView: CharacterView
    latestRequest: InspectedRequest | null
    contextNotice: string
    memory: {
      mode: 'core' | 'none'
      archivePrefix: number | null
      sections: Record<string, { total: number; items: unknown[]; hasMore: boolean }>
      maintenance: WorldJsonObject | null
      notice: string
    }
  }
  limitations: string[]
}
export function creatorInspectionQuery(value: Record<string, unknown>): CreatorInspectionQuery {
  if (Object.keys(value).some(key => !['characterId', 'afterSeq', 'limit', 'memoryOffset'].includes(key)))
    throw new TypeError('未知调试查询字段')
  const result: CreatorInspectionQuery = {}
  if (value.characterId !== undefined) {
    if (typeof value.characterId !== 'string' || !value.characterId || value.characterId.length > 200)
      throw new TypeError('角色标识无效')
    result.characterId = value.characterId
  }
  for (const key of ['afterSeq', 'limit', 'memoryOffset'] as const) {
    if (value[key] === undefined) continue
    const number = typeof value[key] === 'string' && /^\d+$/u.test(value[key]) ? Number(value[key]) : value[key]
    if (
      typeof number !== 'number' ||
      !Number.isSafeInteger(number) ||
      number < (key === 'limit' ? 1 : 0) ||
      (key === 'limit' && number > 100)
    )
      throw new TypeError('调试分页参数无效')
    result[key] = number
  }
  return result
}
