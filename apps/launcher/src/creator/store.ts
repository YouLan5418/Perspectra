import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { CreatorDebugSnapshot } from '../../../../tests/experiments/creator-debug.ts'
import type { CreatorHistoryItem } from '../../../../tests/experiments/creator-history.ts'
import type { CreatorRecord } from '../../../../tests/experiments/creator-records.ts'
import { buildConversation, buildTrace, type ConversationEntry, type RecordSummary } from './model.ts'
import { KIND_LABEL } from './format.ts'
import { creatorSource, type CreatorSource } from './source.ts'
import type { ConsoleView, NameTables, Selection, StatusTone, TraceKind, TraceNode } from './types.ts'

/** 接口单次上限 100；一屏按一页加载，更早内容按需向前翻。 */
const PAGE = 100
const DETAIL_WINDOW = 80
export const POLL_MS = 3000

export interface ServerFilters { characterId: string; entityId: string; search: string }
export interface LocalFilters { kinds: TraceKind[]; tones: StatusTone[] }
export const EMPTY_SERVER: ServerFilters = { characterId: '', entityId: '', search: '' }
export const EMPTY_LOCAL: LocalFilters = { kinds: [], tones: [] }

export const useCreatorStore = defineStore('creator', () => {
  const instanceId = ref('')
  let source: CreatorSource = creatorSource('')

  /** 快照含递归 JSON 结构；用 shallowRef 避免深层类型展开，替换时整体赋值。 */
  const world = shallowRef<CreatorDebugSnapshot | null>(null)
  const history = shallowRef<CreatorHistoryItem[]>([])
  const records = shallowRef<RecordSummary[]>([])
  const details = shallowRef<Record<string, CreatorRecord>>({})
  const loading = ref(false)
  const busy = ref(false)
  const error = ref('')
  const updatedAt = ref('')
  const added = ref(0)
  const follow = ref(true)
  const server = ref<ServerFilters>({ ...EMPTY_SERVER })
  const local = ref<LocalFilters>({ ...EMPTY_LOCAL })
  const showProcess = ref(false)
  const selection = shallowRef<Selection | null>(null)
  const stack = shallowRef<Selection[]>([])
  const detailOpen = ref(false)
  const detailWidth = ref(400)
  const navCollapsed = ref(false)
  const view = ref<ConsoleView>('conversation')
  const entityHistory = shallowRef<Record<string, CreatorHistoryItem[]>>({})
  /** 角色详情：currentView、最近请求与已安装档案分层。 */
  const characterDetails = shallowRef<Record<string, CreatorDebugSnapshot['character']>>({})
  /** 关联跳转目标：对应视图把它滚动到可见位置。 */
  const focusKey = ref('')
  /** 已扫描到的历史下界；向前翻页从这里继续。 */
  const historyFloor = ref(0)
  const recordFloor = ref(0)
  const recordTotal = ref(0)
  /** 末端候选来自 history 的 selection；切换期间接口返回 409，这里只展示最近一次成功读取。 */
  const candidate = ref<{ id: string | null; ids: string[]; tailId: string | null }>({ id: null, ids: [], tailId: null })

  const preview = computed(() => source.preview)
  const captureEnabled = computed(() => world.value?.captureEnabled ?? false)
  const sourceBusy = computed(() => source.preview ? false : (world.value?.busy ?? false))
  const paused = computed(() => world.value?.paused === true)
  const characters = computed(() => world.value?.characters ?? [])
  const entities = computed(() => world.value?.entities ?? [])
  const activities = computed(() => world.value?.activities ?? [])
  const truncated = computed(() => historyFloor.value > 0)

  const names = computed<NameTables>(() => {
    const tables: NameTables = { characters: {}, entities: {}, locations: {} }
    for (const character of characters.value) tables.characters[character.id] = character.name
    for (const entity of entities.value) tables.entities[entity.id] = entity.name
    for (const character of characters.value) if (character.locationId && character.locationName) tables.locations[character.locationId] = character.locationName
    for (const item of history.value) {
      const data = item.event.data as Record<string, unknown>
      const bind = (table: Record<string, string>, id: unknown, name: unknown) => { if (typeof id === 'string' && typeof name === 'string' && !table[id]) table[id] = name }
      if (item.event.eventType === 'location.upsert') bind(tables.locations, data.locationId, data.name)
      if (item.event.eventType === 'entity.upsert') bind(tables.entities, data.entityId, data.name)
      if (item.event.eventType === 'character.upsert') bind(tables.characters, data.characterId, data.name)
    }
    return tables
  })

  function label(id: string | null | undefined, table: keyof NameTables = 'characters') {
    if (!id) return ''
    return names.value[table][id] ?? id.replace(/^[a-z-]+:/u, '')
  }

  const trace = computed<TraceNode[]>(() => buildTrace({ history: history.value, records: records.value, details: details.value, names: names.value }))
  const visibleTrace = computed(() => trace.value.filter(node => {
    if (!showProcess.value && node.processing) return false
    if (local.value.kinds.length && !local.value.kinds.includes(node.kind)) return false
    if (local.value.tones.length && !local.value.tones.includes(node.tone)) return false
    return true
  }))
  const conversation = computed<ConversationEntry[]>(() => buildConversation(visibleTrace.value))

  function mergeHistory(items: CreatorHistoryItem[]) {
    if (!items.length) return 0
    const seen = new Set(history.value.map(item => item.event.seq))
    const fresh = items.filter(item => !seen.has(item.event.seq))
    if (fresh.length) history.value = [...history.value, ...fresh].sort((a, b) => a.event.seq - b.event.seq)
    return fresh.length
  }

  function mergeRecords(items: RecordSummary[]) {
    const table = new Map(records.value.map(record => [record.id, record]))
    const before = table.size
    for (const record of items) table.set(record.id, record)
    const next = [...table.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id))
    records.value = next
    return next.length - before
  }

  function queryFilters() {
    const active = server.value
    return {
      ...(active.characterId ? { characterId: active.characterId } : {}),
      ...(active.entityId ? { entityId: active.entityId } : {}),
      ...(active.search ? { search: active.search } : {}),
    }
  }

  /** 从当前世界时刻向前取一页；接口只支持正向游标，因此显式指定下界。 */
  async function loadHistory(reset: boolean) {
    const head = world.value?.headSeq ?? 0
    const afterSeq = reset ? Math.max(0, head - PAGE) : Math.max(0, historyFloor.value - PAGE)
    const snapshot = await source.history({ afterSeq, limit: PAGE, ...queryFilters() })
    if (snapshot.selection) candidate.value = { id: snapshot.selection.candidateId, ids: snapshot.selection.candidateIds, tailId: snapshot.selection.tailId }
    if (reset) history.value = []
    const fresh = mergeHistory(snapshot.items)
    historyFloor.value = afterSeq
    return fresh
  }

  async function loadRecords(reset: boolean) {
    let offset: number
    if (reset) {
      const probe = await source.records({ offset: 0, limit: 1, ...queryFilters() })
      recordTotal.value = probe.total
      offset = Math.max(0, probe.total - PAGE)
    } else {
      offset = Math.max(0, recordFloor.value - PAGE)
    }
    const snapshot = await source.records({ offset, limit: PAGE, ...queryFilters() })
    if (reset) records.value = []
    recordFloor.value = offset
    recordTotal.value = snapshot.total
    return mergeRecords(snapshot.items)
  }

  const inflight = new Set<string>()

  async function loadRecordDetail(recordId: string): Promise<CreatorRecord | null> {
    const cached = details.value[recordId]
    if (cached) return cached
    if (inflight.has(recordId)) return null
    inflight.add(recordId)
    try {
      const snapshot = await source.records({ recordId, limit: 1 })
      if (!snapshot.record) throw new Error('记录不存在，或已被容量淘汰。')
      details.value = { ...details.value, [recordId]: snapshot.record }
      return snapshot.record
    } finally { inflight.delete(recordId) }
  }

  /** 正文用于落位、思考展示与状态文字；整个窗口内的记录都会读取一次并常驻缓存。 */
  async function loadWindowDetails() {
    const wanted = records.value
      .filter(record => !details.value[record.id] && !inflight.has(record.id))
      .slice(-DETAIL_WINDOW)
    if (wanted.length) {
      const queue = [...wanted]
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (let record = queue.shift(); record; record = queue.shift()) await loadRecordDetail(record.id).catch(() => null)
      }))
    }
    // 采集进行中的记录会更新同一份文件：丢掉缓存，下一轮重新读取。
    const stale = new Set(records.value.filter(record => record.summary.status === 'pending').map(record => record.id))
    if (stale.size && Object.keys(details.value).some(id => stale.has(id))) {
      details.value = Object.fromEntries(Object.entries(details.value).filter(([id]) => !stale.has(id)))
    }
  }

  async function load(reset = true) {
    if (busy.value) return
    busy.value = true
    error.value = ''
    try {
      world.value = await source.debug()
      if (reset) {
        history.value = []
        records.value = []
        details.value = {}
        characterDetails.value = {}
        entityHistory.value = {}
        selection.value = null
        stack.value = []
        detailOpen.value = false
        added.value = 0
      }
      await loadHistory(true)
      await loadRecords(true)
      await loadWindowDetails()
      updatedAt.value = new Date().toISOString()
    } catch (cause) {
      error.value = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '读取失败，请确认当前实例仍在运行。'
    } finally { busy.value = false }
  }

  /** 增量轮询：新事件按游标追加，记录按尾部窗口合并。 */
  async function poll() {
    if (busy.value || loading.value || !world.value) return
    loading.value = true
    try {
      world.value = await source.debug()
      let fresh = 0
      const known = history.value.at(-1)?.event.seq ?? 0
      if ((world.value.headSeq ?? 0) > known) {
        const snapshot = await source.history({ afterSeq: known, limit: PAGE, ...queryFilters() })
        fresh += mergeHistory(snapshot.items)
      }
      const recordSnapshot = await source.records({ offset: Math.max(0, recordTotal.value - 20), limit: PAGE, ...queryFilters() })
      recordTotal.value = recordSnapshot.total
      fresh += mergeRecords(recordSnapshot.items)
      await loadWindowDetails()
      updatedAt.value = new Date().toISOString()
      if (fresh > 0) { if (follow.value) added.value = 0; else added.value += fresh }
    } catch { /* 轮询失败保留上一次可读状态与错误提示 */ } finally { loading.value = false }
  }

  async function loadOlderHistory() {
    if (busy.value || historyFloor.value === 0) return
    busy.value = true
    try { await loadHistory(false) } catch { error.value = '读取更早历史失败。' } finally { busy.value = false }
  }

  async function loadOlderRecords() {
    if (busy.value || recordFloor.value === 0) return
    busy.value = true
    try { await loadRecords(false); await loadWindowDetails() } catch { error.value = '读取更早记录失败。' } finally { busy.value = false }
  }

  async function applyServer(next: Partial<ServerFilters>) {
    server.value = { ...server.value, ...next }
    follow.value = true
    added.value = 0
    await load(true)
  }

  async function resetFilters() {
    server.value = { ...EMPTY_SERVER }
    local.value = { ...EMPTY_LOCAL }
    await load(true)
  }

  function setLocal(next: Partial<LocalFilters>) { local.value = { ...local.value, ...next } }

  /** 角色筛选走服务端查询，这样加载窗口里就是这个角色自己的事件与记录。 */
  async function focusCharacter(id: string) {
    await applyServer({ characterId: server.value.characterId === id ? '' : id })
  }

  async function setCapture(enabled: boolean) {
    try {
      await source.setCapture(enabled)
      if (world.value) world.value = { ...world.value, captureEnabled: enabled }
    } catch { error.value = '采集开关未生效，请确认实例仍在运行。' }
  }

  function select(next: Selection, options: { stack?: boolean } = {}) {
    if (options.stack !== false && selection.value && selection.value.id !== next.id) stack.value = [...stack.value, selection.value]
    selection.value = next
    detailOpen.value = true
  }

  const selectedKey = computed(() => selection.value?.node?.key ?? '')

  /** 点击消息或条目：私有记录读正文，已提交事件直接展示。 */
  function selectNode(node: TraceNode) {
    const name = label(node.characterId) || '世界'
    if (node.recordId) select({ kind: 'record', id: node.recordId, label: `${KIND_LABEL[node.kind]} · ${name}`, node })
    else select({ kind: 'event', id: node.key, label: `${KIND_LABEL[node.kind]} · ${name}`, node })
  }

  function selectEntity(id: string, name: string) { select({ kind: 'entity', id, label: `物品 · ${name}` }) }
  function selectCharacter(id: string) { select({ kind: 'character', id, label: `角色 · ${label(id)}` }) }

  function closeDetail() { detailOpen.value = false }  function back() {
    const previous = stack.value.at(-1)
    stack.value = stack.value.slice(0, -1)
    if (previous) selection.value = previous
    else detailOpen.value = false
  }
  const canGoBack = computed(() => stack.value.length > 0)

  async function loadEntityHistory(entityId: string) {
    if (entityHistory.value[entityId]) return
    const snapshot = await source.history({ entityId, limit: PAGE })
    entityHistory.value = { ...entityHistory.value, [entityId]: snapshot.items }
  }
  const entityFlow = (entityId: string) => entityHistory.value[entityId] ?? []

  async function loadCharacterDetail(characterId: string) {
    if (characterDetails.value[characterId]) return
    const snapshot = await source.debug({ characterId, limit: 50 })
    if (snapshot.character) characterDetails.value = { ...characterDetails.value, [characterId]: snapshot.character }
  }
  const characterDetail = (characterId: string) => characterDetails.value[characterId] ?? null

  const selectionDetail = computed(() => selection.value ? details.value[selection.value.id] ?? null : null)
  const limitations = computed(() => world.value?.limitations ?? [])
  const selectionNode = computed(() => selection.value?.node ?? null)
  /** 失败项默认收在“处理过程”里，用计数提示它们确实存在。 */
  const failureCount = computed(() => trace.value.filter(node => node.tone === 'danger').length)
  const hiddenProcessCount = computed(() => showProcess.value ? 0 : trace.value.filter(node => node.processing).length)

  function focus(nodeKey: string) { focusKey.value = ''; focusKey.value = nodeKey }
  function attach(nextInstanceId: string) {
    if (instanceId.value === nextInstanceId) return
    instanceId.value = nextInstanceId
    source = creatorSource(nextInstanceId)
    world.value = null
    history.value = []
    records.value = []
    details.value = {}
    characterDetails.value = {}
    entityHistory.value = {}
    selection.value = null
    stack.value = []
    error.value = ''
    updatedAt.value = ''
    added.value = 0
    historyFloor.value = 0
    recordFloor.value = 0
    recordTotal.value = 0
    server.value = { ...EMPTY_SERVER }
    local.value = { ...EMPTY_LOCAL }
  }

  return {
    instanceId, preview, world, history, records, details, loading, busy, error, updatedAt, added, follow,
    server, local, showProcess, selection, detailOpen, detailWidth, navCollapsed, view,
    entityHistory, characterDetails, historyFloor, recordFloor, recordTotal, candidate, focusKey,
    captureEnabled, sourceBusy, paused, characters, entities, activities, truncated,
    names, label, trace, visibleTrace, conversation, selectionDetail, selectionNode, limitations, failureCount, hiddenProcessCount, canGoBack,
    attach, load, poll, loadOlderHistory, loadOlderRecords, applyServer, resetFilters, setLocal, focusCharacter,    setCapture, select, selectNode, selectEntity, selectCharacter, selectedKey, closeDetail, back, loadEntityHistory, entityFlow, loadCharacterDetail, characterDetail, ensureDetail: loadRecordDetail, focus,
  }
})
