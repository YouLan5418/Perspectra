import type { CharacterView, StoredWorldEvent, WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import type { InspectedRequest } from '@harness-world/provider-chat'

/** Host-only read API. No paths, provider configuration or arbitrary commands accepted. */
export interface CreatorInspectionQuery {
  characterId?: string
  afterSeq?: number
  limit?: number
  memoryOffset?: number
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
  characters: { id: string; name: string; locationId: string | null; locationName: string | null; sceneIds: string[]; lifecycle: string; lastMovementSeq: number | null; processing: { transport: string; lastActivation: unknown } }[]
  entities: { id: string; name: string; state: WorldJsonObject; holderMeaning: 'custody'; effectiveLocationId: string | null; locationBasis: 'entity' | 'holder' | 'unknown'; lastChangeSeq: number }[]
  statusTruth: { public: WorldJsonObject; characters: Record<string, WorldJsonObject> } | null
  activities: WorldJsonObject[]
  events: { items: StoredWorldEvent[]; nextAfterSeq: number; hasMore: boolean }
  character?: {
    id: string
    currentView: CharacterView
    latestRequest: InspectedRequest | null
    contextNotice: string
    memory: { mode: 'core' | 'native'; archivePrefix: number | null; sections: Record<string, { total: number; items: unknown[]; hasMore: boolean }>; maintenance: WorldJsonObject | null; notice: string }
  }
  limitations: string[]
}
export function creatorInspectionQuery(value: Record<string, unknown>): CreatorInspectionQuery {
  if (Object.keys(value).some(key => !['characterId', 'afterSeq', 'limit', 'memoryOffset'].includes(key))) throw new TypeError('未知调试查询字段')
  const result: CreatorInspectionQuery = {}
  if (value.characterId !== undefined) {
    if (typeof value.characterId !== 'string' || !value.characterId || value.characterId.length > 200) throw new TypeError('角色标识无效')
    result.characterId = value.characterId
  }
  for (const key of ['afterSeq', 'limit', 'memoryOffset'] as const) {
    if (value[key] === undefined) continue
    const number = typeof value[key] === 'string' && /^\d+$/u.test(value[key]) ? Number(value[key]) : value[key]
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < (key === 'limit' ? 1 : 0) || (key === 'limit' && number > 100)) throw new TypeError('调试分页参数无效')
    result[key] = number
  }
  return result
}
