import type { CreatorRecord } from '../../../../desktop/host/creator-records.ts'
import { asArray, asRecord, text } from './format.ts'
import type { RecordSummary } from './model.ts'
import type { TraceKind, TraceNode } from './types.ts'

/**
 * 运行时间线：把轨迹条目（已提交事件 + 私有记录）排到泳道与世界顺序列上，并只按显式标识建立关联。
 * 世界顺序列只表示先后，不表示时长；墙钟时间只来自采集记录自身的时间戳。
 */

export type SystemLane = 'process' | 'rules' | 'world' | 'observation'
export interface Lane {
  id: string
  label: string
  system: boolean
  characterId?: string
  player?: boolean
}
export const SYSTEM_LANES: { id: `sys:${SystemLane}`; label: string; hint: string }[] = [
  { id: 'sys:process', label: '角色处理', hint: '模型调用、上下文、决策、召回与反应周期（需开启采集）' },
  {
    id: 'sys:rules',
    label: '规则裁定',
    hint: '采集到的行动裁定记录与校验拒绝；已提交裁定结果标在行为者泳道的行动块上',
  },
  { id: 'sys:world', label: '世界状态', hint: '物品、状态、活动、场景与世界刻推进' },
  { id: 'sys:observation', label: '观察投递', hint: '实际写入的 observation.upsert；同一行动投递给多人时合并为一块' },
]
export const SYSTEM_COLLAPSED = 'sys:all'

export type TimelineStatus = 'ok' | 'rejected' | 'failed' | 'interrupted' | 'pending' | 'neutral'
export const STATUS_META: Record<TimelineStatus, { label: string; icon: string }> = {
  ok: { label: '成功', icon: '✓' },
  rejected: { label: '拒绝', icon: '✗' },
  failed: { label: '失败', icon: '!' },
  interrupted: { label: '中断', icon: '⏸' },
  pending: { label: '处理中', icon: '…' },
  neutral: { label: '已提交／中性', icon: '·' },
}
export const ABNORMAL: ReadonlySet<TimelineStatus> = new Set(['rejected', 'failed', 'interrupted'])

export interface TimelineItem {
  /** 首个成员的轨迹键；合并块的其他成员键也能定位到这里。 */
  key: string
  node: TraceNode
  members: TraceNode[]
  lane: string
  column: number
  tick: number | null
  /** 私有记录没有世界刻，沿用它落位处之前最近事件的 tick。 */
  tickInherited: boolean
  status: TimelineStatus
  label: string
}
export interface TickGroup {
  tick: number | null
  from: number
  to: number
}
export interface TimelineModel {
  lanes: Lane[]
  items: TimelineItem[]
  columns: number
  ticks: TickGroup[]
  /** 任一成员键 → 所在块。 */
  index: Map<string, TimelineItem>
}

export interface TimelineCharacter {
  id: string
  name: string
}

function eventData(node: TraceNode): Record<string, unknown> {
  return asRecord(node.event?.data)
}

/** 事件自身写明的行动标识；history 的 actionId 可能来自同事务推导，关联时只信显式字段。 */
export function explicitActionId(node: TraceNode, details: Record<string, CreatorRecord> = {}): string {
  if (node.event) {
    const data = eventData(node)
    return text(data.actionId) || text(asRecord(data.value).actionId)
  }
  if (node.recordId && node.kind === 'action') {
    const data = asRecord(details[node.recordId]?.data)
    return text(data.actionId) || text(asRecord(data.action).actionId) || node.actionId || ''
  }
  return ''
}

export function statusOf(node: TraceNode): TimelineStatus {
  switch (node.kind) {
    case 'action':
      return node.statusKey === 'accepted' ? 'ok' : node.statusKey === 'rejected' ? 'rejected' : 'neutral'
    case 'model':
      return node.statusKey === 'ok' ? 'ok' : node.statusKey === 'failed' ? 'failed' : 'pending'
    case 'turn':
      if (node.statusKey === 'failed') return 'failed'
      if (['budget_exhausted', 'expired', 'stale', 'cancelled'].includes(node.statusKey)) return 'interrupted'
      return node.statusKey === 'responded' ? 'ok' : 'neutral'
    default:
      return 'neutral'
  }
}

function systemLane(node: TraceNode): `sys:${SystemLane}` {
  switch (node.kind) {
    case 'context':
    case 'model':
    case 'decision':
    case 'recall':
    case 'turn':
      return 'sys:process'
    case 'observation':
      return 'sys:observation'
    case 'action':
      return 'sys:rules'
    default:
      return 'sys:world'
  }
}

/** 角色泳道只放角色自己的表达、移动和已提交行动；其他一律进系统泳道。 */
export function laneOf(node: TraceNode, characters: ReadonlySet<string>): string {
  const actor = node.characterId && characters.has(node.characterId) ? node.characterId : ''
  if (actor && (node.kind === 'speak' || node.kind === 'movement')) return actor
  if (actor && node.kind === 'action' && node.event) return actor
  return systemLane(node)
}

/** 从已载入事件识别玩家：裁定事件的 sourceRole 或角色创建时的 manual 控制者。 */
export function playerIds(nodes: TraceNode[]): Set<string> {
  const ids = new Set<string>()
  for (const node of nodes) {
    const data = eventData(node)
    if (node.event?.eventType === 'action.resolved' && data.sourceRole === 'player' && text(data.actorId))
      ids.add(text(data.actorId))
    if (node.event?.eventType === 'character.created' && data.controllerClass === 'manual' && text(data.characterId))
      ids.add(text(data.characterId))
  }
  return ids
}

export function buildLanes(characters: TimelineCharacter[], players: ReadonlySet<string>, systemCollapsed: boolean) {
  const people: Lane[] = characters
    .map(character => ({
      id: character.id,
      label: character.name,
      system: false,
      characterId: character.id,
      player: players.has(character.id),
    }))
    .sort((a, b) => Number(b.player) - Number(a.player))
  const system: Lane[] = systemCollapsed
    ? [{ id: SYSTEM_COLLAPSED, label: '系统', system: true }]
    : SYSTEM_LANES.map(lane => ({ id: lane.id, label: lane.label, system: true }))
  return [...people, ...system]
}

/**
 * 同一事务内同一行动的观察合并为一块；已通过的裁定并入同一行动的表达或移动块，避免一句话出现两次。
 * 被拒绝的裁定始终单独成块。
 */
function mergeKey(node: TraceNode, explicit: string): string {
  if (node.kind === 'observation' && node.event) return `obs:${node.event.transactionId}:${explicit}`
  return ''
}

export function buildTimeline(
  nodes: TraceNode[],
  characters: TimelineCharacter[],
  options: { systemCollapsed?: boolean; details?: Record<string, CreatorRecord> } = {},
): TimelineModel {
  const details = options.details ?? {}
  const known = new Set(characters.map(character => character.id))
  const players = playerIds(nodes)
  const lanes = buildLanes(characters, players, options.systemCollapsed === true)
  // 表达与移动事件常常不写 actionId；只有同一事务、同一行为者时才按 history 推导的 actionId 并块（仅影响显示，不作关联证据）。
  const expressed = new Map<string, TraceNode>()
  for (const node of nodes)
    if ((node.kind === 'speak' || node.kind === 'movement') && node.event) {
      const id = explicitActionId(node) || node.actionId || ''
      if (id && !expressed.has(id)) expressed.set(id, node)
    }

  const items: TimelineItem[] = []
  const index = new Map<string, TimelineItem>()
  const merged = new Map<string, TimelineItem>()
  const pendingFold: { into: TraceNode; node: TraceNode }[] = []
  const seen = new Set<string>()
  let lastTick: number | null = null
  for (const node of nodes) {
    // 轮询与回填可能带来同一条目；按轨迹键去重。
    if (seen.has(node.key)) continue
    seen.add(node.key)
    const explicit = explicitActionId(node, details)
    if (node.event?.eventType === 'action.resolved' && node.statusKey === 'accepted' && explicit) {
      const host = expressed.get(explicit)
      if (
        host &&
        host.event!.transactionId === node.event.transactionId &&
        (!host.characterId || host.characterId === node.characterId)
      ) {
        pendingFold.push({ into: host, node })
        continue
      }
    }
    if (node.tick !== undefined) lastTick = node.tick
    const key = mergeKey(node, explicit)
    const existing = key ? merged.get(key) : undefined
    if (existing) {
      existing.members.push(node)
      index.set(node.key, existing)
      continue
    }
    let lane = laneOf(node, known)
    if (options.systemCollapsed && lane.startsWith('sys:')) lane = SYSTEM_COLLAPSED
    const item: TimelineItem = {
      key: node.key,
      node,
      members: [node],
      lane,
      column: items.length,
      tick: node.tick ?? lastTick,
      tickInherited: node.tick === undefined,
      status: statusOf(node),
      label: node.summary,
    }
    items.push(item)
    index.set(node.key, item)
    if (key) merged.set(key, item)
  }
  for (const { into, node } of pendingFold) {
    const host = index.get(into.key)
    if (!host) continue
    host.members.push(node)
    host.status = statusOf(node)
    index.set(node.key, host)
  }
  for (const item of items)
    if (item.node.kind === 'observation' && item.members.length > 1)
      item.label = `观察投递 ×${item.members.length} · ${item.node.summary}`

  const ticks: TickGroup[] = []
  for (const item of items) {
    const last = ticks.at(-1)
    if (last && last.tick === item.tick) last.to = item.column
    else ticks.push({ tick: item.tick, from: item.column, to: item.column })
  }
  return { lanes, items, columns: items.length, ticks, index }
}

/* ── 筛选 ─────────────────────────────────────────────── */

export interface TimelineFilters {
  characterIds: string[]
  kinds: TraceKind[]
  statuses: TimelineStatus[]
  search: string
  abnormalOnly: boolean
  showSystem: boolean
}
export const EMPTY_TIMELINE_FILTERS: TimelineFilters = {
  characterIds: [],
  kinds: [],
  statuses: [],
  search: '',
  abnormalOnly: false,
  showSystem: true,
}

export function activeFilterCount(filters: TimelineFilters): number {
  return (
    (filters.characterIds.length ? 1 : 0) +
    (filters.kinds.length ? 1 : 0) +
    (filters.statuses.length ? 1 : 0) +
    (filters.search.trim() ? 1 : 0) +
    (filters.abnormalOnly ? 1 : 0) +
    (filters.showSystem ? 0 : 1)
  )
}

/** 节点层面的筛选；筛掉的节点不参与排列，被隐藏条数由调用方明示。 */
export function filterNodes(
  nodes: TraceNode[],
  filters: TimelineFilters,
  characters: TimelineCharacter[],
  label: (id: string | null | undefined) => string,
): TraceNode[] {
  const known = new Set(characters.map(character => character.id))
  const search = filters.search.trim().toLocaleLowerCase()
  return nodes.filter(node => {
    const lane = laneOf(node, known)
    if (!filters.showSystem && lane.startsWith('sys:')) return false
    if (filters.characterIds.length && !(node.characterId && filters.characterIds.includes(node.characterId)))
      return false
    if (filters.kinds.length && !filters.kinds.includes(node.kind)) return false
    const status = statusOf(node)
    if (filters.statuses.length && !filters.statuses.includes(status)) return false
    if (filters.abnormalOnly && !ABNORMAL.has(status)) return false
    if (search) {
      const haystack = [
        node.summary,
        node.detail,
        node.statusLabel,
        label(node.characterId),
        node.event?.eventType ?? '',
        node.actionId ?? '',
        node.seq === undefined ? '' : `#${node.seq}`,
      ]
        .join(' ')
        .toLocaleLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}

/* ── 墙钟时间 ─────────────────────────────────────────── */

export interface ClockItem {
  key: string
  node: TraceNode
  lane: string
  start: number
  /** 只有记录了耗时的调用才有结束时间；否则是瞬时标记。 */
  end: number | null
}
export interface ClockModel {
  available: boolean
  reason: string
  items: ClockItem[]
  min: number
  max: number
  /** 已提交事件没有墙钟时间，在这个模式下不显示。 */
  omittedEvents: number
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

export function buildClock(
  nodes: TraceNode[],
  details: Record<string, CreatorRecord>,
  characters: TimelineCharacter[],
  systemCollapsed = false,
): ClockModel {
  const known = new Set(characters.map(character => character.id))
  const items: ClockItem[] = []
  let omittedEvents = 0
  const seen = new Set<string>()
  for (const node of nodes) {
    if (!node.record) {
      if (node.event) omittedEvents += 1
      continue
    }
    // 同一请求在轨迹里拆成上下文与调用两条；墙钟模式只画调用本身。
    if (node.kind === 'context' || seen.has(node.record.id)) continue
    seen.add(node.record.id)
    const duration = node.record.summary.durationMs
    let start: number | null
    if (node.record.kind === 'action') start = parseTime(asRecord(details[node.record.id]?.data).startedAt)
    else start = parseTime(node.record.capturedAt)
    const hasSpan = start !== null && typeof duration === 'number' && Number.isFinite(duration)
    // 行动记录的正文未读取时只有采集时刻，按瞬时标记处理，不倒推开始时间。
    if (start === null) start = parseTime(node.record.capturedAt)
    if (start === null) continue
    let lane = laneOf(node, known)
    if (systemCollapsed && lane.startsWith('sys:')) lane = SYSTEM_COLLAPSED
    items.push({ key: node.key, node, lane, start, end: hasSpan ? start + duration! : null })
  }
  items.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))
  if (!items.length)
    return {
      available: false,
      reason:
        '已载入的数据里没有墙钟时间：已提交事件只有序号与世界刻；模型请求、裁定耗时等计时只在开启采集后的私有记录中存在。',
      items,
      min: 0,
      max: 0,
      omittedEvents,
    }
  const min = items[0]!.start
  const max = Math.max(...items.map(item => item.end ?? item.start))
  return { available: true, reason: '', items, min, max: Math.max(max, min + 1), omittedEvents }
}

/* ── 确定关联 ─────────────────────────────────────────── */

export type RelationKind = 'action' | 'eventRef' | 'decision' | 'commit' | 'cycle'
export const RELATION_META: Record<RelationKind, { label: string; evidence: string; rank: number }> = {
  action: { label: '同一行动', evidence: '共享显式 actionId', rank: 0 },
  eventRef: { label: '行动记录引用', evidence: '采集到的行动记录 eventRefs 列出该事件序号', rank: 1 },
  decision: { label: '同一决策', evidence: '采集记录共享 decisionId', rank: 2 },
  commit: { label: '同一原子提交', evidence: '共享 transactionId，一次性写入事件日志', rank: 3 },
  cycle: { label: '同一处理周期', evidence: '裁定事件共享 participantId（同一次角色激活）', rank: 4 },
}

export interface Relation {
  node: TraceNode
  kind: RelationKind
}

export interface CausalChain {
  relations: Relation[]
  origin: Relation[]
  verdict: Relation[]
  changes: Relation[]
  observations: Relation[]
  followUps: Relation[]
  recipients: { characterId: string; visibility: 'full' | 'occurrence_only'; observationSeq: number }[]
  /** 已知角色中没有收到该行动观察记录的人；只有找到对应裁定事件时才给出。 */
  unobserved: string[] | null
  /** 同一提交中有多个行动时，状态变更不能归到某一个行动。 */
  sharedCommit: { actions: number } | null
  notes: string[]
}

const PROCESS_KINDS: ReadonlySet<TraceKind> = new Set(['context', 'model', 'decision', 'recall'])
const CHANGE_KINDS: ReadonlySet<TraceKind> = new Set(['entity', 'activity', 'movement', 'world', 'event'])

function decisionOf(record: RecordSummary | undefined): string {
  return record?.decisionId ?? ''
}

/**
 * 只按显式标识收集关联：actionId、行动记录 eventRefs、decisionId、transactionId、participantId。
 * 时间相邻、同场景或同 tick 都不构成关联。
 */
export function causalChain(
  target: TraceNode,
  nodes: TraceNode[],
  details: Record<string, CreatorRecord>,
  characters: TimelineCharacter[],
): CausalChain {
  const actionIds = new Set<string>()
  const decisions = new Set<string>()
  const transactions = new Set<string>()
  const participants = new Set<string>()
  const refs = new Set<number>()
  const notes: string[] = []

  let ownAction = explicitActionId(target, details)
  // 发言、移动事件常不写 actionId；同一原子提交里同一行为者的裁定事件是它的记录依据。
  if (!ownAction && target.event && target.actionId) {
    const verdict = nodes.find(
      node =>
        node.event?.eventType === 'action.resolved' &&
        node.event.transactionId === target.event!.transactionId &&
        explicitActionId(node) === target.actionId &&
        (!target.characterId || node.characterId === target.characterId),
    )
    if (verdict) ownAction = target.actionId
  }
  if (ownAction) actionIds.add(ownAction)
  if (target.event) transactions.add(target.event.transactionId)
  const ownDecision = decisionOf(target.record)
  if (ownDecision) decisions.add(ownDecision)

  // 采集记录：decisionId → 行动记录 → actionId / eventRefs。
  const actionRecords = nodes.filter(node => node.record?.kind === 'action')
  const expand = () => {
    for (const node of actionRecords) {
      const data = asRecord(details[node.recordId!]?.data)
      const id = explicitActionId(node, details)
      const decision = decisionOf(node.record)
      if ((decision && decisions.has(decision)) || (id && actionIds.has(id))) {
        if (id) actionIds.add(id)
        if (decision) decisions.add(decision)
        for (const seq of asArray(data.eventRefs)) if (typeof seq === 'number') refs.add(seq)
      }
    }
  }
  expand()
  for (const node of nodes) {
    if (node.event?.eventType !== 'action.resolved') continue
    const id = explicitActionId(node)
    if (!id || !actionIds.has(id)) continue
    transactions.add(node.event.transactionId)
    const participant = text(eventData(node).participantId)
    if (participant) participants.add(participant)
  }

  const found = new Map<string, Relation>()
  const add = (node: TraceNode, kind: RelationKind) => {
    if (node.key === target.key) return
    const previous = found.get(node.key)
    if (!previous || RELATION_META[kind].rank < RELATION_META[previous.kind].rank) found.set(node.key, { node, kind })
  }
  const cycleActions = new Set<string>()
  for (const node of nodes) {
    const id = explicitActionId(node, details)
    if (id && actionIds.has(id)) add(node, 'action')
    if (node.seq !== undefined && refs.has(node.seq)) add(node, 'eventRef')
    const decision = decisionOf(node.record)
    if (decision && decisions.has(decision)) add(node, 'decision')
    if (node.event && transactions.has(node.event.transactionId)) add(node, 'commit')
    if (node.event?.eventType === 'action.resolved') {
      const participant = text(eventData(node).participantId)
      if (participant && participants.has(participant) && id && !actionIds.has(id)) {
        add(node, 'cycle')
        cycleActions.add(id)
      }
    }
  }
  // 同一周期的其他轮次：只带出它们的表达与移动，不展开全部观察。
  for (const node of nodes) {
    const id = explicitActionId(node)
    if (id && cycleActions.has(id) && (node.kind === 'speak' || node.kind === 'movement')) add(node, 'cycle')
  }

  const relations = [...found.values()].sort(
    (a, b) => a.node.sortSeq - b.node.sortSeq || a.node.sortRank - b.node.sortRank,
  )
  const anchorSeq = target.sortSeq
  const resolvedNodes = nodes.filter(
    node => node.event?.eventType === 'action.resolved' && actionIds.has(explicitActionId(node)),
  )
  const all = [target, ...relations.map(relation => relation.node)]
  const isOrigin = (node: TraceNode) => PROCESS_KINDS.has(node.kind) || node.kind === 'speak'
  const isVerdict = (node: TraceNode) => node.kind === 'action'
  // 选中项本身也列在它所属的一步里，便于对照；同一周期的较早轮次归到“发起”之前的上下文。
  const self: Relation = { node: target, kind: 'action' }
  const pick = (test: (node: TraceNode) => boolean) =>
    [self, ...relations].filter(relation => relation.kind !== 'cycle' && test(relation.node))
  const earlierCycle = relations.filter(relation => relation.kind === 'cycle' && relation.node.sortSeq < anchorSeq)

  const recipients = resolvedNodes.flatMap(node => node.history?.recipients ?? [])
  let unobserved: string[] | null = null
  if (resolvedNodes.length) {
    const seen = new Set(recipients.map(recipient => recipient.characterId))
    unobserved = characters.map(character => character.id).filter(id => !seen.has(id))
  } else if (target.event && !ownAction) {
    notes.push('该事件没有显式 actionId，无法按行动查到受众；不按同场景或时间推定谁知道。')
  }

  let sharedCommit: CausalChain['sharedCommit'] = null
  if (transactions.size) {
    const actions = new Set(
      nodes
        .filter(node => node.event?.eventType === 'action.resolved' && transactions.has(node.event.transactionId))
        .map(node => explicitActionId(node))
        .filter(Boolean),
    )
    if (actions.size > 1) sharedCommit = { actions: actions.size }
  }
  if (!target.record && !nodes.some(node => node.record))
    notes.push('本段没有采集记录：模型调用、决策与反应周期结束原因未采集，不代表没有发生。')
  if (all.some(node => node.kind === 'model'))
    notes.push('模型请求记录了它基于的世界前缀（视图序号），但没有记录具体用到了哪些观察；后续回应的依据不画成关联。')

  return {
    relations,
    origin: [...earlierCycle, ...pick(isOrigin)],
    verdict: pick(isVerdict),
    changes: pick(node => CHANGE_KINDS.has(node.kind) && !isVerdict(node)),
    observations: pick(node => node.kind === 'observation'),
    followUps: relations.filter(
      relation =>
        (relation.kind === 'cycle' && relation.node.sortSeq > anchorSeq) ||
        (relation.node.kind === 'turn' && relation.node.sortSeq >= anchorSeq),
    ),
    recipients,
    unobserved,
    sharedCommit,
    notes,
  }
}

/* ── 状态前后对比 ─────────────────────────────────────── */

export interface Transition {
  label: string
  before: string | null
  after: string
  /** 前值来自已载入的更早事件；没有载入到时为 false，不推测初值。 */
  beforeKnown: boolean
}

/** 物品与状态的“变更前 → 变更后”：只从已载入事件日志里同一对象的上一条记录取前值。 */
export function transitions(
  target: TraceNode,
  nodes: TraceNode[],
  name: (id: string, table: 'characters' | 'locations') => string,
): Transition[] {
  const event = target.event
  if (!event) return []
  const data = asRecord(event.data)
  const earlier = nodes.filter(node => node.event && node.event.seq < event.seq)
  if (event.eventType.startsWith('entity.')) {
    const entityId = text(data.entityId)
    const previous = [...earlier]
      .reverse()
      .find(
        node => node.event!.eventType.startsWith('entity.') && text(asRecord(node.event!.data).entityId) === entityId,
      )
    const before = previous ? asRecord(previous.event!.data) : null
    const fields: [string, string, (value: unknown) => string][] = [
      ['描述', 'kind', value => text(value)],
      ['地点', 'locationId', value => (text(value) ? name(text(value), 'locations') : '')],
      ['保管者', 'holderId', value => (text(value) ? name(text(value), 'characters') : '无人保管')],
    ]
    return fields
      .filter(([, field]) => field in data)
      .map(([label, field, show]) => ({
        label,
        before: before ? show(before[field]) : null,
        after: show(data[field]),
        beforeKnown: before !== null,
      }))
  }
  if (event.eventType === 'status.updated') {
    return asArray(data.changes).map(change => {
      const entry = asRecord(change)
      const key = text(entry.key)
      const holder = text(entry.holderId)
      let before: unknown
      let known = false
      for (const node of [...earlier].reverse()) {
        if (node.event!.eventType !== 'status.updated') continue
        const hit = asArray(asRecord(node.event!.data).changes)
          .map(asRecord)
          .find(item => text(item.key) === key && text(item.holderId) === holder)
        if (hit) {
          before = hit.value
          known = true
          break
        }
      }
      const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))
      return {
        label: holder ? `${name(holder, 'characters')} · ${key}` : key,
        before: known ? show(before) : null,
        after: show(entry.value),
        beforeKnown: known,
      }
    })
  }
  return []
}

/** 行为者在该事件之前的位置：只按已载入的移动 / 创建事件推导，未载入时返回 null。 */
export function locationBefore(characterId: string, seq: number, nodes: TraceNode[]): string | null {
  let location: string | null = null
  for (const node of nodes) {
    if (!node.event || node.event.seq >= seq) continue
    const data = asRecord(node.event.data)
    if (node.event.eventType === 'character.moved' && data.characterId === characterId)
      location = text(data.toLocationId) || location
    if (node.event.eventType === 'character.created' && data.characterId === characterId)
      location = text(data.locationId) || location
  }
  return location
}
