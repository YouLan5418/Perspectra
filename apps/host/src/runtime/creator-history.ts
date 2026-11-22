import type { StoredWorldEvent, WorldAddress, WorldJsonObject } from '@perspectra/sdk/contracts'
import type { CreatorScope } from './creator-records.ts'
import { currentEntityState, type EntityState } from '@perspectra/core/kernel'
import type { WorldStore } from '@perspectra/core/store'

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
  movement?: {
    from: string | null
    to: string | null
    party: 'listed' | 'unlisted' | 'unrecorded' | 'disabled'
    rosterSeq: number | null
    source: 'move' | 'party-follow' | 'activity' | 'gameplay' | 'rule' | 'unrecorded'
    initiator: string | null
    role: string | null
    moduleId: string | null
    activity: string | null
    operation: string | null
    phase: string | null
    hook: string | null
    rule: string | null
  }
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
const string = (value: unknown) => (typeof value === 'string' ? value : null)
type Roster = { ids: Set<string>; seq: number }

function movementDetails(
  mover: string,
  from: string | null,
  data: WorldJsonObject,
  source: WorldJsonObject,
  verdict: WorldJsonObject,
  hasRpgParty: boolean,
  roster?: Roster,
): NonNullable<CreatorHistoryItem['movement']> {
  const follow =
    source.kind === 'party-follow' ||
    (source.moduleId === 'official-rpg' &&
      source.hook === 'afterAction' &&
      source.operation === 'move' &&
      source.rule === 'party-follow')
  const kind = source.kind
  return {
    from,
    to: string(data.toLocationId),
    party: !hasRpgParty ? 'disabled' : !roster ? 'unrecorded' : roster.ids.has(mover) ? 'listed' : 'unlisted',
    rosterSeq: roster?.seq ?? null,
    source: follow
      ? 'party-follow'
      : kind === 'move' || kind === 'activity' || kind === 'gameplay' || kind === 'rule'
        ? kind
        : 'unrecorded',
    initiator: string(source.actorId) ?? (kind === 'move' ? mover : string(verdict.actorId)),
    role: string(verdict.sourceRole),
    moduleId: string(source.moduleId),
    activity: string(source.activityKey),
    operation: string(source.operation),
    phase: string(source.phase),
    hook: string(source.hook),
    rule: string(source.rule),
  }
}
function referencesEntity(action: WorldJsonObject | null, id: string): boolean {
  const parameters = object(action?.parameters),
    target = object(parameters.targetRef)
  // Explicit typed targets only; mentions in dialogue never establish a transfer or an attempted use.
  return parameters.entityId === id || (target.kind === 'entity' && target.id === id)
}
/** Look up the submitted parameters by the committed resolution's transaction and action ID. */
export function committedAction(authority: WorldJsonObject | null | undefined, actionId: string) {
  if (authority?.actionId === actionId) return object(authority.action)
  return Array.isArray(authority?.actions)
    ? (authority.actions.map(object).find(action => action.actionId === actionId) ?? null)
    : null
}
/** Derive from the full committed prefix before paging, so recipient and custody evidence crosses pages. */
export function creatorHistory(
  store: WorldStore,
  address: WorldAddress,
  worldVersion: string,
  query: CreatorHistoryQuery,
  hasRpgParty: boolean,
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
    return committedAction(authority, actionId)
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
  let roster: Roster | undefined
  const locations = new Map<string, string>()
  for (const event of events) {
    const data = object(event.data),
      value = object(data.value),
      actor = data.actorId ?? data.characterId
    const mover = string(data.characterId)
    const moving = event.eventType === 'character.moved' && mover !== null
    const from =
      moving && !Object.hasOwn(data, 'fromLocationId') ? (locations.get(mover) ?? null) : string(data.fromLocationId)
    if (moving && typeof data.toLocationId === 'string') locations.set(mover, data.toLocationId)
    if (
      (event.eventType === 'character.created' || event.eventType === 'character.upsert') &&
      mover &&
      typeof data.locationId === 'string'
    )
      locations.set(mover, data.locationId)
    // Read the committed prefix even when the roster change was on a different page or actor.
    if (hasRpgParty && event.eventType === 'status.updated' && Array.isArray(data.changes)) {
      for (const change of data.changes.map(object)) {
        if (change.holderId === null && change.key === 'rpg-party' && Array.isArray(change.value))
          roster = { ids: new Set(change.value.filter((id): id is string => typeof id === 'string')), seq: event.seq }
      }
    }
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
    const source = moving ? object(data.movementSource) : {}
    if (moving) {
      // A later action by the moved character may share this transaction. Only the closing
      // verdict of this action can identify its initiator when the producer did not save an ID.
      resolved = transaction.find(candidate => candidate.seq > event.seq && candidate.eventType === 'action.resolved')
      const verdict = object(resolved?.data)
      if (
        verdict.accepted !== true ||
        verdict.actorId !== (source.actorId ?? mover) ||
        (!source.actorId && verdict.actionType !== 'move')
      )
        resolved = undefined
    }
    const actionIdValue = source.actionId ?? data.actionId ?? value.actionId ?? object(resolved?.data).actionId
    const actionId = typeof actionIdValue === 'string' ? actionIdValue : null
    if (actionId !== null)
      resolved = transaction.find(
        candidate => candidate.eventType === 'action.resolved' && object(candidate.data).actionId === actionId,
      )
    const action = actionFor(event, actionId)
    const actionObservers = actionId === null ? [] : (observations.get(actionId) ?? [])
    const observationEvents = moving
      ? actionObservers.filter(observation => {
          const content = object(object(object(observation.data).value).content)
          return object(content.movement).characterId === mover
        })
      : actionObservers
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
      ...(moving
        ? { movement: movementDetails(mover, from, data, source, object(resolved?.data), hasRpgParty, roster) }
        : {}),
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
