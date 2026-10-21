import type { CreatorHistoryItem } from '../../../../desktop/host/creator-history.ts'
import type { CreatorRecord } from '../../../../desktop/host/creator-records.ts'
import { asArray, asRecord, expressionSegments, inlineJson, readable, requestStatus, segmentsText, text, turnStatus } from './format.ts'
import type { NameTables, TraceNode } from './types.ts'

export type { TraceNode } from './types.ts'
export type RecordSummary = Omit<CreatorRecord, 'data'>

interface BuildInput {
  history: CreatorHistoryItem[]
  records: RecordSummary[]
  /** 已读取正文的记录；仅 request / action 会被主动读取，用于落位和思考展示。 */
  details: Record<string, CreatorRecord>
  names: NameTables
}

/** 私有记录同序落位时排名相同，用组序与组内位置区分先后。 */
const EVENT_RANK = 1_000_000
const GROUP_STRIDE = 100

function shorten(id: string | null | undefined, table: Record<string, string>): string {
  if (!id) return ''
  return table[id] ?? id.replace(/^[a-z-]+:/u, '')
}

export function actionLabel(action: Record<string, unknown> | null, names: NameTables): string {
  const type = text(action?.actionType) || '行动'
  const parameters = asRecord(action?.parameters)
  const target = asRecord(parameters.targetRef)
  const entityId = text(parameters.entityId) || (text(target.kind) === 'entity' ? text(target.id) : '')
  const characterId = text(target.kind) === 'character' ? text(target.id) : text(parameters.targetCharacterId)
  const locationId = text(parameters.toLocationId) || text(parameters.locationId)
  const destination = entityId ? shorten(entityId, names.entities)
    : characterId ? shorten(characterId, names.characters)
      : locationId ? shorten(locationId, names.locations) : ''
  const spoken = segmentsText(expressionSegments(parameters))
  const tail = destination || (spoken ? `“${spoken.slice(0, 40)}”` : '')
  return tail ? `${type} · ${tail}` : type
}

const ACTIVITY_OPERATION: Record<string, string> = { start: '开始', pause: '暂停', resume: '继续', abandon: '放弃', end: '结束', published: '记入表达' }
const ACTION_VERB: Record<string, string> = { speak: '发言', move: '移动', interact: '互动', take: '拿取', give: '交给' }

/** 观察正文 → 一句人读摘要：对白、移动、结果说明依次优先，原始结构留给详情面板。 */
function observationSummary(content: Record<string, unknown>, names: NameTables): string {
  if (text(content.contentVisibility) === 'occurrence_only') return '只知道发生了一次互动，看不到内容'
  const actor = shorten(text(content.actorId), names.characters)
  const spoken = segmentsText(expressionSegments(content.speech))
  if (spoken) return `${actor ? `${actor} 说：` : ''}${spoken}`
  const movement = asRecord(content.movement)
  if (text(movement.toLocationId)) return `${shorten(text(movement.characterId), names.characters) || actor} 移动到 ${shorten(text(movement.toLocationId), names.locations)}`
  const description = text(content.resultDescription).trim()
  const actionType = text(content.actionType)
  const verb = ACTION_VERB[actionType] ?? actionType
  if (description) return [actor && verb ? `${actor} ${verb}` : actor, description].filter(Boolean).join('：')
  const fallback = readable(content)
  return fallback ? inlineJson(fallback, 140) : ''
}

function speakAudience(item: CreatorHistoryItem): string {
  const data = asRecord(item.event.data)
  const addressees = asArray(data.addresseeIds).filter((id): id is string => typeof id === 'string')
  const full = item.recipients.filter(r => r.visibility === 'full').length
  const occurrence = item.recipients.length - full
  const parts: string[] = []
  if (addressees.length) parts.push(`交谈对象 ${addressees.length}`)
  if (full) parts.push(`完整观察 ${full}`)
  if (occurrence) parts.push(`仅知发生 ${occurrence}`)
  return parts.length ? parts.join(' · ') : '无记录受众'
}

/** 已提交事件 → 轨迹条目。事件只有逻辑 tick 与序号，不补造墙钟时间。 */
function eventNode(item: CreatorHistoryItem, names: NameTables): TraceNode {
  const event = item.event
  const data = asRecord(event.data)
  const value = asRecord(data.value)
  const actorId = item.actorId ?? (typeof data.characterId === 'string' ? data.characterId : null)
  const base = { groupId: `e${event.seq}`, sortSeq: event.seq, sortRank: EVENT_RANK, seq: event.seq, tick: event.tick, processing: false, history: item, event, actionId: item.actionId ?? undefined }

  switch (event.eventType) {
    case 'character.speak':
      return { ...base, key: `e${event.seq}`, kind: 'speak', characterId: actorId, statusKey: 'committed', statusLabel: '已提交', tone: 'accent',
        summary: segmentsText(expressionSegments(data)) || '（空表达）', segments: expressionSegments(data), detail: speakAudience(item) }
    case 'observation.upsert': {
      const observerId = text(value.observerId)
      const content = asRecord(value.content)
      const visibility = text(content.contentVisibility)
      const summary = observationSummary(content, names)
      return { ...base, key: `e${event.seq}`, kind: 'observation', characterId: observerId || actorId, statusKey: visibility || 'committed',
        statusLabel: visibility === 'occurrence_only' ? '仅知发生' : '已提交', tone: visibility === 'occurrence_only' ? 'muted' : 'ok',
        summary: summary || '收到一条观察', detail: '' }
    }
    case 'action.resolved': {
      const accepted = data.accepted === true
      return { ...base, key: `e${event.seq}`, kind: 'action', characterId: actorId, statusKey: accepted ? 'accepted' : 'rejected',
        statusLabel: accepted ? '已通过' : '被拒绝', tone: accepted ? 'ok' : 'danger',
        summary: actionLabel(item.action ?? { actionType: data.actionType }, names), detail: text(data.reason) }
    }
    case 'action.rejected':
      return { ...base, key: `e${event.seq}`, kind: 'action', characterId: actorId, statusKey: 'rejected', statusLabel: '被拒绝', tone: 'danger',
        summary: `${text(data.actionType) || '行动'} 未通过校验`, detail: text(data.reason) }
    case 'character.moved':
      return { ...base, key: `e${event.seq}`, kind: 'movement', characterId: actorId, statusKey: 'committed', statusLabel: '已提交', tone: 'muted',
        summary: `移动到 ${shorten(text(data.toLocationId), names.locations)}`,
        detail: text(data.fromLocationId) ? `来自 ${shorten(text(data.fromLocationId), names.locations)}` : '' }
    case 'entity.upsert':
    case 'entity.transferred':
    case 'entity.remove': {
      const entityId = text(data.entityId) || text(data.id)
      const holder = text(data.holderId) || text(value.holderId)
      const change = item.entityChange
      const before = asRecord(change?.before)
      const after = asRecord(change?.after)
      const move = change ? `${shorten(text(before.holderId), names.characters) || '无人保管'} → ${shorten(text(after.holderId), names.characters) || '无人保管'}`
        : holder ? `保管者 ${shorten(holder, names.characters)}` : ''
      const verb = event.eventType === 'entity.transferred' ? '物品转交' : event.eventType === 'entity.remove' ? '物品移除' : '物品更新'
      return { ...base, key: `e${event.seq}`, kind: 'entity', characterId: holder || actorId, statusKey: 'committed', statusLabel: '已提交', tone: 'warn',
        summary: `${verb} · ${shorten(entityId, names.entities)}`, detail: move }
    }
    case 'activity.updated':
      return { ...base, key: `e${event.seq}`, kind: 'activity', characterId: text(data.actorId) || actorId, statusKey: 'committed', statusLabel: '已提交', tone: 'accent',
        summary: `活动 ${text(data.activityKey) || 'default'} · ${ACTIVITY_OPERATION[text(data.operation)] ?? (text(data.operation) || '更新')}`, detail: readable(data.description) }
    case 'world.tick-advanced':
      return { ...base, key: `e${event.seq}`, kind: 'world', characterId: null, statusKey: 'committed', statusLabel: '已提交', tone: 'muted',
        summary: `世界推进到 tick ${text(data.tick)}`, detail: '' }
    default:
      return { ...base, key: `e${event.seq}`, kind: 'event', characterId: actorId, statusKey: 'committed', statusLabel: '已提交', tone: 'muted',
        summary: `${event.eventType}${item.actionId ? ` · ${actionLabel(item.action, names)}` : ''}`, detail: inlineJson(data, 120) }
  }
}

interface RequestData { continuation?: boolean; model?: string; contextParts?: { name: string }[]; omitted?: string; preset?: { origin?: { name?: string; scope?: string } } }

function contextNode(record: RecordSummary, request: RequestData | undefined, groupId: string): TraceNode {
  const parts = request?.contextParts ?? []
  return {
    key: `${record.id}:context`, groupId, kind: 'context', characterId: record.characterId, statusKey: 'prepared', statusLabel: '已准备', tone: 'ok',
    summary: '角色上下文与预设', detail: [request ? `${parts.length} 个分项` : '正在读取正文', request?.preset?.origin?.name].filter(Boolean).join(' · '),
    sortSeq: Number.MAX_SAFE_INTEGER, sortRank: 0, processing: true, recordId: record.id, decisionId: record.decisionId, record,
  }
}

function requestNode(record: RecordSummary, request: RequestData | undefined, index: number, total: number, published: boolean, groupId: string): TraceNode {
  const [label, tone] = requestStatus(record.summary.status ?? 'pending')
  const attempt = total > 1 ? `第 ${index + 1} 次决策${index > 0 ? '（格式修正）' : ''}` : '本次决策'
  return {
    key: record.id, groupId, kind: 'model', characterId: record.characterId, statusKey: record.summary.status ?? 'pending', statusLabel: label, tone,
    summary: `${request?.continuation ? '继续处理' : '新刺激'} · ${attempt}`,
    detail: [record.summary.model, request?.contextParts ? `上下文 ${request.contextParts.length} 项` : '', request?.omitted ?? ''].filter(Boolean).join(' · '),
    durationMs: record.summary.durationMs, sortSeq: Number.MAX_SAFE_INTEGER, sortRank: 0, processing: !published,
    recordId: record.id, decisionId: record.decisionId, record,
  }
}

/** 正文未读取时只报“已记录”，不把未知状态显示成未命中或失败。 */
function recordNode(record: RecordSummary, detail: CreatorRecord | undefined, names: NameTables, groupId: string): TraceNode {
  const data = asRecord((detail?.data ?? {}) as Record<string, unknown>)
  const loaded = detail !== undefined
  const summaryStatus = record.summary.status
  const common = {
    groupId, sortSeq: Number.MAX_SAFE_INTEGER, sortRank: 0, processing: true, recordId: record.id,
    decisionId: record.decisionId, record, durationMs: record.summary.durationMs,
  }
  switch (record.kind) {
    case 'decision':
      return { ...common, key: record.id, kind: 'decision', characterId: record.characterId, statusKey: text(data.source) || 'recorded',
        statusLabel: loaded ? (text(data.source) === 'script' ? '脚本固定演出' : '模型提案') : '已记录',
        tone: loaded ? 'accent' : 'muted',
        summary: loaded ? `决策提案 · ${text(data.source) === 'script' ? '脚本' : '模型'}` : '决策提案 · 正在读取正文',
        detail: loaded ? inlineJson(data.value, 140) : '' }
    case 'action': {
      const action = asRecord(data.action)
      // summary.status 来自记录摘要，无需读取正文即可判定裁定结果。
      const accepted = summaryStatus === 'accepted'
      const actionId = text(data.actionId) || text(action.actionId)
      return { ...common, key: record.id, kind: 'action', characterId: record.characterId, statusKey: summaryStatus ?? 'unknown',
        statusLabel: accepted ? '已通过' : summaryStatus === 'rejected' ? '被拒绝' : '已记录', tone: accepted ? 'ok' : summaryStatus === 'rejected' ? 'danger' : 'muted',
        actionId, processing: false,
        summary: loaded ? actionLabel(Object.keys(action).length ? action : null, names) : '行动记录 · 正在读取正文',
        detail: text(data.reason) }
    }
    case 'turn': {
      const status = summaryStatus ?? text(data.status)
      const [label, tone] = turnStatus(status)
      // 轮次在所属回合的已提交事件之后收尾，落位由调用方按 eventRefs 决定。
      return { ...common, key: record.id, kind: 'turn', characterId: record.characterId, statusKey: status,
        statusLabel: label, tone, summary: `反应周期结束 · ${label}`,
        detail: [data.calls === undefined ? '' : `${text(data.calls)} 次调用`, text(data.failure)].filter(Boolean).join(' · ') }
    }
    case 'recall': {
      const memories = asArray(data.memories)
      return { ...common, key: record.id, kind: 'recall', characterId: record.characterId, statusKey: 'returned', processing: false,
        statusLabel: loaded ? (memories.length ? `已返回 ${memories.length} 条` : '未命中') : '已记录',
        tone: loaded ? (memories.length ? 'ok' : 'muted') : 'muted',
        summary: loaded ? `主动召回 · ${readable(data.query) || '（无查询词）'}` : '主动召回 · 正在读取正文',
        detail: loaded ? `基于序号 ${text(data.asOfWorldSeq)} 的视图` : '' }
    }
    default:
      return { ...common, key: record.id, kind: 'event', characterId: record.characterId, statusKey: 'unknown', statusLabel: record.kind, tone: 'muted',
        summary: record.summary.label, detail: '' }
  }
}

/** 行动记录通过 eventRefs 或匹配的 action.resolved 落位到已提交事件之前。 */
function actionAnchor(detail: CreatorRecord | undefined, resolved: Map<string, number>): number | undefined {
  const data = asRecord((detail?.data ?? {}) as Record<string, unknown>)
  const actionId = text(data.actionId) || text(asRecord(data.action).actionId)
  if (actionId && resolved.has(actionId)) return resolved.get(actionId)
  const refs = asArray(data.eventRefs).filter((seq): seq is number => typeof seq === 'number')
  return refs.length ? Math.min(...refs) : undefined
}

/** 把已提交事件与私有记录合并为一条按阅读顺序排列的轨迹。 */
export function buildTrace(input: BuildInput): TraceNode[] {
  const events = input.history.map(item => eventNode(item, input.names))
  const resolved = new Map<string, number>()
  for (const item of input.history) if (item.event.eventType === 'action.resolved' && item.actionId) resolved.set(item.actionId, item.event.seq)

  const groups = new Map<string, RecordSummary[]>()
  for (const record of input.records) {
    const key = record.decisionId ?? record.id
    const list = groups.get(key) ?? []
    list.push(record)
    groups.set(key, list)
  }

  const produced: TraceNode[] = []
  /** 已读取正文的行动记录取代对应的 action.resolved 事件行，避免同一行动出现两次。 */
  const superseded = new Set<string>()
  const maxSeq = input.history.reduce((max, item) => Math.max(max, item.event.seq), 0)
  const order = [...groups.entries()]
  const anchors = new Map<string, number | undefined>()
  const ends = new Map<string, number | undefined>()
  for (const [key, list] of order) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id))
    const seqs: number[] = []
    for (const record of list) if (record.kind === 'action') {
      const detail = input.details[record.id]
      const data = asRecord((detail?.data ?? {}) as Record<string, unknown>)
      const found = actionAnchor(detail, resolved)
      if (found !== undefined) seqs.push(found)
      for (const seq of asArray(data.eventRefs)) if (typeof seq === 'number') seqs.push(seq)
      const actionId = text(data.actionId)
      if (actionId && resolved.has(actionId)) superseded.add(`e${resolved.get(actionId)}`)
    }
    anchors.set(key, seqs.length ? Math.min(...seqs) : undefined)
    ends.set(key, seqs.length ? Math.max(...seqs) : undefined)
  }

  let groupIndex = 0
  for (const [key, list] of order) {
    // 未能定位到事件的组按采集时间排在下一个已定位组之前；最后一段排到全部已提交事件之后。
    const anchor = anchors.get(key)
    let cursor = anchor
    if (cursor === undefined) {
      const next = order.slice(groupIndex + 1).find(([other]) => anchors.get(other) !== undefined)
      cursor = next ? anchors.get(next[0])! - 0.5 : maxSeq + 0.5
    }
    const requests = list.filter(record => record.kind === 'request')
    // 只有产出了已提交表达的处理才算发表；沉默、失败与取消留在处理过程里。
    const published = list.some(record => record.kind === 'action' && record.summary.status === 'accepted')
    const base = groupIndex * GROUP_STRIDE
    groupIndex += 1
    let position = 0
    for (const record of list) {
      const detail = input.details[record.id]
      if (record.kind === 'request') {
        produced.push({ ...contextNode(record, detail?.data as RequestData | undefined, key), sortSeq: cursor, sortRank: base + position })
        position += 1
        produced.push({ ...requestNode(record, detail?.data as RequestData | undefined, requests.indexOf(record), requests.length, published, key), sortSeq: cursor, sortRank: base + position })
      } else {
        const end = ends.get(key)
        produced.push({ ...recordNode(record, detail, input.names, key), sortSeq: record.kind === 'turn' && end !== undefined ? end + 0.9 : cursor, sortRank: base + position })
      }
      position += 1
    }
  }

  const kept = superseded.size ? events.filter(node => !superseded.has(node.key)) : events
  return [...kept, ...produced].sort((a, b) => a.sortSeq - b.sortSeq || a.sortRank - b.sortRank || a.key.localeCompare(b.key))
}

export interface ConversationEntry {
  key: string
  kind: 'message' | 'row' | 'process'
  /** 消息上方的模型处理链（上下文、召回、思考、工具）。 */
  process: TraceNode[]
  node?: TraceNode
  /** 同一行动分发给多位观察者时合并为一行，这里是全部观察条目。 */
  members?: TraceNode[]
}

/** 处理步骤：折叠在对应回应上方，或作为未发表的处理过程单独成条。 */
const STEP_KINDS = new Set(['context', 'recall', 'model', 'decision', 'turn'])

/** 连续阅读排版：模型思考放在对应回应上方，未发表的处理按组收起。 */
export function buildConversation(nodes: TraceNode[]): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  let buffer: TraceNode[] = []
  let group = ''
  const flush = () => { if (buffer.length) entries.push({ key: `${buffer[0]!.key}:p`, kind: 'process', process: buffer }); buffer = [] }
  // 发言的听众已标在消息头上，对应的通过行动与逐人观察在阅读视图里不再重复列出；
  // 活动推进行已说明发生了什么，同一行动的通过行也不再单列。
  const spoken = new Set(nodes.filter(node => node.kind === 'speak' && node.actionId).map(node => node.actionId!))
  const shown = new Set(nodes.filter(node => (node.kind === 'speak' || node.kind === 'activity') && node.actionId).map(node => node.actionId!))
  for (const node of nodes) {
    if (node.actionId && node.kind === 'observation' && spoken.has(node.actionId)) continue
    if (node.actionId && node.kind === 'action' && node.tone !== 'danger' && shown.has(node.actionId)) continue
    if (node.kind === 'observation' && node.actionId) {
      const last = entries.at(-1)
      if (last?.kind === 'row' && last.node?.kind === 'observation' && last.node.actionId === node.actionId) { last.members!.push(node); continue }
      entries.push({ key: node.key, kind: 'row', process: [], node, members: [node] })
      continue
    }
    if (STEP_KINDS.has(node.kind)) {
      // 只有处理步骤会开启新的一组；中间穿插的已提交事件不打断归组。
      if (node.groupId !== group) { flush(); group = node.groupId }
      buffer.push(node)
      continue
    }
    if (node.kind === 'speak') { entries.push({ key: node.key, kind: 'message', process: buffer, node }); buffer = []; group = ''; continue }
    entries.push({ key: node.key, kind: 'row', process: [], node })
  }
  flush()
  return entries
}
