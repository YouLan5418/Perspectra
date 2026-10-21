import type { StoredWorldEvent, WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import type { CreatorScope } from './creator-records.ts'
import { currentEntityState, type EntityState } from '@harness-world/kernel'
import type { WorldStore } from '@harness-world/store-sqlite'

export interface CreatorHistoryQuery {
  afterSeq?: number
  eventSeq?: number
  limit?: number
  characterId?: string
  entityId?: string
  eventType?: string
  status?: 'accepted' | 'rejected'
  search?: string
}
export interface CreatorHistoryItem {
  event: StoredWorldEvent
  actorId: string | null
  actionId: string | null
  action: WorldJsonObject | null
  recipients: { characterId: string; visibility: 'full' | 'occurrence_only'; observationSeq: number }[]
  relatedSeqs: number[]
  entityChange: { before: EntityState | null; after: EntityState | null; followsHolder: boolean } | null
}
export interface CreatorHistorySnapshot {
  scope?: CreatorScope
  selection?: { worldVersion: string; tailId: string | null; candidateId: string | null; candidateIds: string[] }
  address: WorldAddress
  worldVersion: string
  headSeq: number
  tick: number
  items: CreatorHistoryItem[]
  nextAfterSeq: number
  hasMore: boolean
  limitations: string[]
}
export function creatorHistoryQuery(value: Record<string, unknown>): CreatorHistoryQuery {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      key =>
        !['afterSeq', 'eventSeq', 'limit', 'characterId', 'entityId', 'eventType', 'status', 'search'].includes(key),
    )
  )
    throw new TypeError('未知历史查询字段')
  const result: CreatorHistoryQuery = {}
  for (const key of ['characterId', 'entityId', 'eventType', 'search'] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'string' || !value[key].length || value[key].length > 200)
      throw new TypeError('历史查询字符串无效')
    result[key] = value[key]
  }
  if (value.status !== undefined) {
    if (value.status !== 'accepted' && value.status !== 'rejected') throw new TypeError('历史状态无效')
    result.status = value.status
  }
  for (const key of ['afterSeq', 'eventSeq', 'limit'] as const) {
    if (value[key] === undefined) continue
    const number = typeof value[key] === 'string' && /^\d+$/.test(value[key]) ? Number(value[key]) : value[key]
    if (
      typeof number !== 'number' ||
      !Number.isSafeInteger(number) ||
      number < (key === 'afterSeq' ? 0 : 1) ||
      (key === 'limit' && number > 100)
    )
      throw new TypeError('历史分页无效')
    result[key] = number
  }
  return result
}
const object = (value: unknown): WorldJsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as WorldJsonObject) : {}
function referencesEntity(action: WorldJsonObject | null, id: string): boolean {
  const parameters = object(action?.parameters),
    target = object(parameters.targetRef)
  // Explicit typed targets only; mentions in dialogue never establish a transfer or an attempted use.
  return parameters.entityId === id || (target.kind === 'entity' && target.id === id)
}
/** Derive from the full committed prefix before paging, so recipient and custody evidence crosses pages. */
export function creatorHistory(
  store: WorldStore,
  address: WorldAddress,
  worldVersion: string,
  query: CreatorHistoryQuery,
): CreatorHistorySnapshot {
  const head = store.head(address),
    events = store.readEvents(address, head.headSeq),
    limit = query.limit ?? 50
  if ((query.afterSeq ?? 0) > head.headSeq || (query.eventSeq ?? 0) > head.headSeq)
    throw new TypeError('查询游标超过当前世界时刻')
  const authorities = new Map<string, WorldJsonObject | null>()
  const actionFor = (event: StoredWorldEvent, actionId: string | null): WorldJsonObject | null => {
    if (!actionId) return null
    if (!authorities.has(event.transactionId))
      authorities.set(event.transactionId, store.readRoundAuthority(address, event.transactionId)?.authority ?? null)
    const authority = authorities.get(event.transactionId)
    if (authority?.actionId === actionId) return object(authority.action)
    return Array.isArray(authority?.actions)
      ? (authority.actions.map(object).find(action => action.actionId === actionId) ?? null)
      : null
  }
  const byTransaction = new Map<string, StoredWorldEvent[]>()
  const observations = new Map<string, StoredWorldEvent[]>()
  for (const event of events) {
    const list = byTransaction.get(event.transactionId) ?? []
    list.push(event)
    byTransaction.set(event.transactionId, list)
    const value = object(object(event.data).value)
    if (event.eventType === 'observation.upsert' && typeof value.actionId === 'string') {
      const list = observations.get(value.actionId) ?? []
      list.push(event)
      observations.set(value.actionId, list)
    }
  }
  let entityState: EntityState | undefined
  const entityEvents: StoredWorldEvent[] = []
  const matches: CreatorHistoryItem[] = []
  for (const event of events) {
    const data = object(event.data),
      value = object(data.value),
      actor = data.actorId ?? data.characterId
    const before = entityState ?? null
    const directEntity =
      query.entityId !== undefined && data.entityId === query.entityId && event.eventType.startsWith('entity.')
    const followsHolder =
      query.entityId !== undefined &&
      event.eventType === 'character.moved' &&
      data.characterId === entityState?.holderId
    if (directEntity) {
      entityEvents.push(event)
      entityState = currentEntityState(entityEvents, query.entityId!)
    }
    if ((query.eventSeq !== undefined && event.seq !== query.eventSeq) || event.seq <= (query.afterSeq ?? 0)) continue
    const transaction = byTransaction.get(event.transactionId)!
    let resolved =
      event.eventType === 'action.resolved'
        ? event
        : transaction.find(
            candidate =>
              candidate.seq >= event.seq &&
              candidate.eventType === 'action.resolved' &&
              (actor === undefined || object(candidate.data).actorId === actor),
          )
    const actionIdValue = data.actionId ?? value.actionId ?? object(resolved?.data).actionId
    const actionId = typeof actionIdValue === 'string' ? actionIdValue : null
    if (actionId !== null)
      resolved = transaction.find(
        candidate => candidate.eventType === 'action.resolved' && object(candidate.data).actionId === actionId,
      )
    const action = actionFor(event, actionId)
    const observationEvents = actionId === null ? [] : (observations.get(actionId) ?? [])
    const actorId = typeof actor === 'string' ? actor : typeof action?.actorId === 'string' ? action.actorId : null
    if (query.entityId !== undefined && !directEntity && !followsHolder && !referencesEntity(action, query.entityId))
      continue
    if (query.characterId !== undefined && actorId !== query.characterId && value.observerId !== query.characterId)
      continue
    if (query.eventType !== undefined && event.eventType !== query.eventType) continue
    if (
      query.status !== undefined &&
      (event.eventType !== 'action.resolved' || (data.accepted === true ? 'accepted' : 'rejected') !== query.status)
    )
      continue
    if (
      query.search !== undefined &&
      !JSON.stringify({ event, action }).toLocaleLowerCase().includes(query.search.toLocaleLowerCase())
    )
      continue
    matches.push({
      event,
      actorId,
      actionId,
      action,
      recipients: observationEvents.map(observation => {
        const observed = object(object(observation.data).value)
        return {
          characterId: String(observed.observerId),
          visibility: object(observed.content).contentVisibility === 'occurrence_only' ? 'occurrence_only' : 'full',
          observationSeq: observation.seq,
        }
      }),
      relatedSeqs: [
        ...new Set([...(resolved ? [resolved.seq] : []), ...observationEvents.map(observation => observation.seq)]),
      ],
      entityChange: directEntity || followsHolder ? { before, after: entityState ?? null, followsHolder } : null,
    })
  }
  const items = matches.slice(0, limit),
    hasMore = matches.length > limit
  return {
    address,
    worldVersion,
    headSeq: head.headSeq,
    tick: head.tick,
    items,
    nextAfterSeq: hasMore ? items.at(-1)!.event.seq : head.headSeq,
    hasMore,
    limitations: [
      '历史来自已提交事件；模型提案、思考和未提交尝试通过 creator-records 查看。',
      '受众来自实际 observation.upsert；空数组不证明无人知情。',
      'entityChange 只重建保管和地点；随携带者移动不表示物品独立转移。',
      '事件提供逻辑 tick 和序号，不补造未记录的墙钟时间。',
    ],
  }
}
