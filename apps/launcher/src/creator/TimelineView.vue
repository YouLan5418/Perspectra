<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowRightToLine, Crosshair, Maximize2, RefreshCw, RotateCcw, X } from '@lucide/vue'
import { KIND_LABEL, timeLabel } from './format.ts'
import { useCreatorStore } from './store.ts'
import {
  activeFilterCount,
  buildClock,
  buildTimeline,
  causalChain,
  EMPTY_TIMELINE_FILTERS,
  filterNodes,
  RELATION_META,
  STATUS_META,
  SYSTEM_COLLAPSED,
  SYSTEM_LANES,
  type ClockItem,
  type RelationKind,
  type TimelineItem,
  type TimelineStatus,
} from './timeline.ts'
import type { TraceKind, TraceNode } from './types.ts'

const store = useCreatorStore()

/* ── 布局常量 ─────────────────────────────────────────── */
const LABEL_W = 132
const LANE_H = 40
const DEFAULT_SCALE = 84
const MIN_SCALE = 1.5
const MAX_SCALE = 260
/** 每列像素低于此值时按世界刻聚合显示。 */
const AGGREGATE_BELOW = 16
/** 每列像素达到此值时块内显示文字。 */
const LABEL_FROM = 58
const BUCKETS = 160

const mode = ref<'order' | 'clock'>('order')
const scale = ref(DEFAULT_SCALE)
/** 实际耗时模式：每秒像素。 */
const clockScale = ref(40)
const systemCollapsed = ref(false)
const focusOnly = ref(false)

const track = ref<HTMLElement | null>(null)
const view = ref({ left: 0, top: 0, width: 800, height: 300 })

/* ── 数据 ─────────────────────────────────────────────── */
const characters = computed(() => store.timelineCharacters)
const filters = computed(() => store.timelineFilters)
const allNodes = computed(() => store.timelineTrace)
const filteredNodes = computed(() => filterNodes(allNodes.value, filters.value, characters.value, store.label))
const hiddenCount = computed(() => allNodes.value.length - filteredNodes.value.length)

const selectedNode = computed<TraceNode | null>(() => {
  const key = store.selectedKey
  if (!key) return null
  return allNodes.value.find(node => node.key === key) ?? null
})
const chain = computed(() =>
  selectedNode.value ? causalChain(selectedNode.value, allNodes.value, store.details, characters.value) : null,
)
const relatedKind = computed(() => {
  const map = new Map<string, RelationKind>()
  for (const relation of chain.value?.relations ?? []) map.set(relation.node.key, relation.kind)
  return map
})

const shownNodes = computed(() => {
  if (focusOnly.value && selectedNode.value) {
    const keep = new Set([selectedNode.value.key, ...relatedKind.value.keys()])
    return allNodes.value.filter(node => keep.has(node.key))
  }
  return filteredNodes.value
})
const model = computed(() =>
  buildTimeline(shownNodes.value, characters.value, { systemCollapsed: systemCollapsed.value, details: store.details }),
)
const lanes = computed(() =>
  model.value.lanes.filter(lane => {
    if (lane.system) return filters.value.showSystem || focusOnly.value
    if (focusOnly.value) return true
    return !filters.value.characterIds.length || filters.value.characterIds.includes(lane.characterId!)
  }),
)
const laneIndex = computed(() => new Map(lanes.value.map((lane, index) => [lane.id, index])))
const laneCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const item of model.value.items) counts.set(item.lane, (counts.get(item.lane) ?? 0) + 1)
  return counts
})

const clock = computed(() => buildClock(shownNodes.value, store.details, characters.value, systemCollapsed.value))
watch(
  () => clock.value.available,
  available => {
    if (!available && mode.value === 'clock') mode.value = 'order'
  },
)

const selectedItem = computed<TimelineItem | null>(() =>
  store.selectedKey ? (model.value.index.get(store.selectedKey) ?? null) : null,
)
const selectedLabel = computed(() => {
  const node = selectedNode.value
  return node ? (node.seq !== undefined ? `#${node.seq}` : KIND_LABEL[node.kind]) : ''
})

/* ── 坐标 ─────────────────────────────────────────────── */
const aggregated = computed(() => mode.value === 'order' && scale.value < AGGREGATE_BELOW)
const contentWidth = computed(() => {
  if (mode.value === 'clock') {
    const span = (clock.value.max - clock.value.min) / 1000
    return Math.max(view.value.width, span * clockScale.value + 160)
  }
  return Math.max(view.value.width, model.value.columns * scale.value + 120)
})
const contentHeight = computed(() => lanes.value.length * LANE_H)

const visibleRange = computed(() => {
  const from = Math.max(0, Math.floor(view.value.left / scale.value) - 2)
  const to = Math.min(model.value.columns, Math.ceil((view.value.left + view.value.width) / scale.value) + 2)
  return { from, to }
})
const visibleItems = computed(() => {
  if (mode.value !== 'order' || aggregated.value) return []
  const { from, to } = visibleRange.value
  // 列号就是数组下标，直接切片即可。
  return model.value.items.slice(from, to).filter(item => laneIndex.value.has(item.lane))
})

interface Aggregate {
  key: string
  lane: string
  tick: number | null
  from: number
  to: number
  count: number
  status: TimelineStatus
  first: TimelineItem
}
const STATUS_RANK: Record<TimelineStatus, number> = {
  failed: 5,
  rejected: 4,
  interrupted: 3,
  pending: 2,
  ok: 1,
  neutral: 0,
}
const aggregates = computed<Aggregate[]>(() => {
  if (!aggregated.value) return []
  const { from, to } = visibleRange.value
  const result: Aggregate[] = []
  for (const group of model.value.ticks) {
    if (group.to < from || group.from > to) continue
    const byLane = new Map<string, Aggregate>()
    for (let column = group.from; column <= group.to; column += 1) {
      const item = model.value.items[column]!
      if (!laneIndex.value.has(item.lane)) continue
      const current = byLane.get(item.lane)
      if (current) {
        current.count += item.members.length
        current.to = column
        if (STATUS_RANK[item.status] > STATUS_RANK[current.status]) current.status = item.status
      } else
        byLane.set(item.lane, {
          key: `${group.from}:${item.lane}`,
          lane: item.lane,
          tick: group.tick,
          from: column,
          to: column,
          count: item.members.length,
          status: item.status,
          first: item,
        })
    }
    result.push(...byLane.values())
  }
  return result
})

const clockItems = computed(() => {
  if (mode.value !== 'clock') return []
  const left = view.value.left - 40,
    right = view.value.left + view.value.width + 40
  return clock.value.items.filter(item => {
    if (!laneIndex.value.has(item.lane)) return false
    const x = clockX(item.start),
      end = item.end === null ? x : clockX(item.end)
    return end >= left && x <= right
  })
})
function clockX(time: number) {
  return ((time - clock.value.min) / 1000) * clockScale.value + 60
}

function laneTop(lane: string) {
  return (laneIndex.value.get(lane) ?? 0) * LANE_H
}
function itemCenter(item: TimelineItem) {
  return { x: item.column * scale.value + scale.value / 2, y: laneTop(item.lane) + LANE_H / 2 }
}

/* ── 刻度 ─────────────────────────────────────────────── */
const rulerTicks = computed(() => {
  if (mode.value === 'clock') {
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
    const step = steps.find(value => value * clockScale.value >= 90) ?? 3600
    const marks: { x: number; label: string; major: boolean }[] = []
    const start = Math.floor(Math.max(0, view.value.left - 60) / clockScale.value / step) * step
    for (let second = start; ; second += step) {
      const x = second * clockScale.value + 60
      if (x > view.value.left + view.value.width + 100) break
      marks.push({ x, label: timeLabel(new Date(clock.value.min + second * 1000).toISOString()), major: true })
      if (marks.length > 200) break
    }
    return marks
  }
  const { from, to } = visibleRange.value
  const marks: { x: number; label: string; major: boolean }[] = []
  let lastX = -Infinity
  for (const group of model.value.ticks) {
    if (group.to < from || group.from > to) continue
    const x = group.from * scale.value
    if (x - lastX < 54) continue
    lastX = x
    marks.push({ x, label: group.tick === null ? '无 tick' : `tick ${group.tick}`, major: true })
  }
  return marks
})
const seqMarks = computed(() => {
  if (mode.value !== 'order' || scale.value < 44) return []
  return visibleItems.value
    .filter(item => item.node.seq !== undefined)
    .map(item => ({ x: item.column * scale.value + 4, label: `#${item.node.seq}` }))
})
const tickBands = computed(() => {
  if (mode.value !== 'order') return []
  const { from, to } = visibleRange.value
  return model.value.ticks
    .filter(group => group.to >= from && group.from <= to)
    .map(group => ({
      key: group.from,
      x: group.from * scale.value,
      width: (group.to - group.from + 1) * scale.value,
    }))
})

/* ── 概览 ─────────────────────────────────────────────── */
const overview = computed(() => {
  const buckets = Array.from({ length: BUCKETS }, () => ({ count: 0, status: 'neutral' as TimelineStatus }))
  const total = Math.max(1, mode.value === 'clock' ? clock.value.items.length : model.value.columns)
  if (mode.value === 'clock') {
    const span = Math.max(1, clock.value.max - clock.value.min)
    for (const item of clock.value.items) {
      const bucket = buckets[Math.min(BUCKETS - 1, Math.floor(((item.start - clock.value.min) / span) * BUCKETS))]!
      bucket.count += 1
      const status = clockStatus(item)
      if (STATUS_RANK[status] > STATUS_RANK[bucket.status]) bucket.status = status
    }
  } else
    for (const item of model.value.items) {
      const bucket = buckets[Math.min(BUCKETS - 1, Math.floor((item.column / total) * BUCKETS))]!
      bucket.count += item.members.length
      if (STATUS_RANK[item.status] > STATUS_RANK[bucket.status]) bucket.status = item.status
    }
  const max = Math.max(1, ...buckets.map(bucket => bucket.count))
  return buckets.map(bucket => ({ ...bucket, height: bucket.count ? Math.max(10, (bucket.count / max) * 100) : 0 }))
})
const windowBox = computed(() => {
  const width = contentWidth.value
  return {
    left: `${(view.value.left / width) * 100}%`,
    width: `${Math.max(0.6, (Math.min(view.value.width, width) / width) * 100)}%`,
  }
})
const overviewRef = ref<HTMLElement | null>(null)
function overviewJump(event: PointerEvent) {
  const element = overviewRef.value
  if (!element) return
  const move = (clientX: number) => {
    const rect = element.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    scrollTo(fraction * contentWidth.value - view.value.width / 2, undefined, true)
  }
  move(event.clientX)
  element.setPointerCapture(event.pointerId)
  const onMove = (next: PointerEvent) => move(next.clientX)
  const stop = () => {
    element.removeEventListener('pointermove', onMove)
    element.removeEventListener('pointerup', stop)
  }
  element.addEventListener('pointermove', onMove)
  element.addEventListener('pointerup', stop)
}

/* ── 滚动、缩放、拖拽 ─────────────────────────────────── */
let expectedLeft = -1
function syncView() {
  const element = track.value
  if (!element) return
  view.value = {
    left: element.scrollLeft,
    top: element.scrollTop,
    width: element.clientWidth,
    height: element.clientHeight,
  }
}
function atEnd() {
  const element = track.value
  return !!element && element.scrollLeft + element.clientWidth >= element.scrollWidth - 4
}
function onScroll() {
  syncView()
  const element = track.value
  if (!element) return
  if (expectedLeft >= 0 && Math.abs(element.scrollLeft - expectedLeft) < 2) {
    expectedLeft = -1
    return
  }
  expectedLeft = -1
  // 手动移动后暂停跟随；回到最右端则恢复。
  const end = atEnd()
  if (store.follow !== end) store.follow = end
  if (end) store.added = 0
}
function scrollTo(left: number, top?: number, user = false) {
  const element = track.value
  if (!element) return
  const max = Math.max(0, element.scrollWidth - element.clientWidth)
  const next = Math.min(max, Math.max(0, left))
  if (!user) expectedLeft = next
  element.scrollLeft = next
  if (top !== undefined) element.scrollTop = top
  syncView()
}
function scrollToEnd() {
  void nextTick(() => {
    const element = track.value
    if (element) scrollTo(element.scrollWidth)
  })
}
defineExpose({ scrollToEnd })

function zoomAt(factor: number, clientX?: number) {
  const element = track.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const offset = clientX === undefined ? element.clientWidth / 2 : clientX - rect.left
  if (mode.value === 'clock') {
    const at = (element.scrollLeft + offset - 60) / clockScale.value
    clockScale.value = Math.min(4000, Math.max(0.02, clockScale.value * factor))
    void nextTick(() => scrollTo(at * clockScale.value + 60 - offset, undefined, true))
    return
  }
  const column = (element.scrollLeft + offset) / scale.value
  scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.value * factor))
  void nextTick(() => scrollTo(column * scale.value - offset, undefined, true))
}
function onWheel(event: WheelEvent) {
  // 横向滚动（触控板或 Shift+滚轮）交给浏览器平移；纵向滚轮缩放。
  if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
  event.preventDefault()
  zoomAt(event.deltaY < 0 ? 1.18 : 1 / 1.18, event.clientX)
}
const dragging = ref(false)
function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('.tl-item')) return
  const element = track.value
  if (!element) return
  const start = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }
  let moved = false
  element.setPointerCapture(event.pointerId)
  const onMove = (next: PointerEvent) => {
    const dx = next.clientX - start.x,
      dy = next.clientY - start.y
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return
    moved = true
    dragging.value = true
    scrollTo(start.left - dx, start.top - dy, true)
  }
  const stop = () => {
    dragging.value = false
    element.removeEventListener('pointermove', onMove)
    element.removeEventListener('pointerup', stop)
    element.removeEventListener('pointercancel', stop)
  }
  element.addEventListener('pointermove', onMove)
  element.addEventListener('pointerup', stop)
  element.addEventListener('pointercancel', stop)
}

function centerOn(item: TimelineItem | null) {
  const element = track.value
  if (!item || !element) return
  void nextTick(() => {
    const { x, y } = itemCenter(item)
    scrollTo(x - element.clientWidth / 2, Math.max(0, y - element.clientHeight / 2), true)
  })
}
function centerClock(key: string) {
  const element = track.value
  const item = clock.value.items.find(entry => entry.key === key)
  if (!item || !element) return false
  scrollTo(clockX(item.start) - element.clientWidth / 2, undefined, true)
  return true
}

function followLatest() {
  store.follow = true
  store.added = 0
  scrollToEnd()
}
function locateCurrent() {
  if (!store.selectedKey) return
  if (mode.value === 'clock' && centerClock(store.selectedKey)) return
  if (!selectedItem.value && !focusOnly.value && hiddenCount.value) {
    // 选中项被筛选隐藏时先说明，不悄悄改动筛选。
    notice.value = '当前选中条目被筛选隐藏；清除筛选后可定位。'
    return
  }
  store.follow = false
  centerOn(selectedItem.value)
}
function resetZoom() {
  scale.value = DEFAULT_SCALE
  clockScale.value = 40
  followLatest()
}
const notice = ref('')

/* ── 交互 ─────────────────────────────────────────────── */
function choose(item: TimelineItem) {
  notice.value = ''
  store.selectNode(item.node)
}
function chooseNode(node: TraceNode) {
  notice.value = ''
  store.selectNode(node)
}
function zoomInto(aggregate: Aggregate) {
  const element = track.value
  if (!element) return
  scale.value = Math.max(DEFAULT_SCALE / 1.5, AGGREGATE_BELOW * 2)
  store.follow = false
  void nextTick(() => scrollTo(aggregate.from * scale.value - element.clientWidth / 3, undefined, true))
}
function onKeydown(event: KeyboardEvent) {
  const items = model.value.items
  if (!items.length) return
  if (event.key === '+' || event.key === '=') return zoomAt(1.25)
  if (event.key === '-') return zoomAt(1 / 1.25)
  if (mode.value !== 'order') return
  const current = selectedItem.value?.column ?? -1
  let next = -1
  if (event.key === 'ArrowRight') next = Math.min(items.length - 1, current + 1)
  else if (event.key === 'ArrowLeft') next = Math.max(0, current < 0 ? items.length - 1 : current - 1)
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = items.length - 1
  if (next < 0) return
  event.preventDefault()
  const item = items[next]!
  choose(item)
  store.follow = false
  const element = track.value
  if (element) {
    const x = item.column * scale.value
    if (x < element.scrollLeft || x + scale.value > element.scrollLeft + element.clientWidth) centerOn(item)
  }
}

/* ── 筛选 ─────────────────────────────────────────────── */
function setFilters(next: Partial<typeof EMPTY_TIMELINE_FILTERS>) {
  store.timelineFilters = { ...store.timelineFilters, ...next }
}
function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter(item => item !== value) : [...list, value]
}
function clearFilters() {
  store.timelineFilters = { ...EMPTY_TIMELINE_FILTERS }
  focusOnly.value = false
}
const filterCount = computed(() => activeFilterCount(filters.value))
const kindOptions = Object.entries(KIND_LABEL) as [TraceKind, string][]
const statusOptions = Object.entries(STATUS_META) as [TimelineStatus, { label: string; icon: string }][]
const currentCharacter = computed(() => selectedNode.value?.characterId ?? '')
function onlyCurrentCharacter() {
  if (!currentCharacter.value) return
  setFilters({ characterIds: [currentCharacter.value] })
}
const filterChips = computed(() => {
  const chips: { key: string; label: string; clear: () => void }[] = []
  const current = filters.value
  if (current.characterIds.length)
    chips.push({
      key: 'c',
      label: `角色：${current.characterIds.map(id => store.label(id)).join('、')}`,
      clear: () => setFilters({ characterIds: [] }),
    })
  if (current.kinds.length)
    chips.push({
      key: 'k',
      label: `类型：${current.kinds.map(kind => KIND_LABEL[kind]).join('、')}`,
      clear: () => setFilters({ kinds: [] }),
    })
  if (current.statuses.length)
    chips.push({
      key: 's',
      label: `结果：${current.statuses.map(status => STATUS_META[status].label).join('、')}`,
      clear: () => setFilters({ statuses: [] }),
    })
  if (current.search.trim())
    chips.push({ key: 'q', label: `搜索：${current.search.trim()}`, clear: () => setFilters({ search: '' }) })
  if (current.abnormalOnly)
    chips.push({ key: 'a', label: '只看异常', clear: () => setFilters({ abnormalOnly: false }) })
  if (!current.showSystem)
    chips.push({ key: 'y', label: '已隐藏系统事件', clear: () => setFilters({ showSystem: true }) })
  return chips
})
const serverScope = computed(() => {
  const parts: string[] = []
  if (store.server.characterId) parts.push(`角色 ${store.label(store.server.characterId)}`)
  if (store.server.entityId) parts.push(`物品 ${store.label(store.server.entityId, 'entities')}`)
  if (store.server.search) parts.push(`搜索「${store.server.search}」`)
  return parts.join('、')
})

/* ── 显示 ─────────────────────────────────────────────── */
const CATEGORY: Record<TraceKind, string> = {
  speak: 'speak',
  movement: 'move',
  action: 'action',
  context: 'model',
  model: 'model',
  decision: 'model',
  recall: 'model',
  turn: 'model',
  observation: 'observe',
  entity: 'state',
  activity: 'activity',
  world: 'world',
  event: 'state',
}
function itemText(item: TimelineItem) {
  const node = item.node
  const actor = node.characterId ? store.label(node.characterId) : ''
  const label = node.kind === 'speak' ? `说：${node.summary}` : item.label
  return item.lane.startsWith('sys') && actor ? `${actor}：${label}` : label
}
function itemTitle(node: TraceNode, item?: TimelineItem) {
  const status = item ? STATUS_META[item.status] : STATUS_META.neutral
  return [
    `${KIND_LABEL[node.kind]} · ${node.summary}`,
    `角色：${store.label(node.characterId) || '世界'}`,
    `世界刻：${node.tick ?? (item?.tick === null || item?.tick === undefined ? '无' : `${item.tick}（沿用落位处）`)}`,
    `序号：${node.seq === undefined ? '无（私有记录）' : `#${node.seq}`}`,
    `结果：${status.icon} ${node.statusLabel}`,
    item && item.members.length > 1 ? `合并 ${item.members.length} 条` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
function clockStatus(item: ClockItem): TimelineStatus {
  const node = item.node
  if (node.kind === 'action')
    return node.statusKey === 'accepted' ? 'ok' : node.statusKey === 'rejected' ? 'rejected' : 'neutral'
  if (node.kind === 'model') return node.statusKey === 'ok' ? 'ok' : node.statusKey === 'failed' ? 'failed' : 'pending'
  if (node.kind === 'turn')
    return node.statusKey === 'failed'
      ? 'failed'
      : ['budget_exhausted', 'expired', 'stale', 'cancelled'].includes(node.statusKey)
        ? 'interrupted'
        : 'neutral'
  return 'neutral'
}
function itemStyle(item: TimelineItem) {
  const width = Math.max(8, Math.min(scale.value - 4, 260))
  return {
    left: `${item.column * scale.value + (scale.value - width) / 2}px`,
    top: `${laneTop(item.lane) + 7}px`,
    width: `${width}px`,
    height: `${LANE_H - 14}px`,
  }
}
function aggregateStyle(aggregate: Aggregate) {
  return {
    left: `${aggregate.from * scale.value + 1}px`,
    top: `${laneTop(aggregate.lane) + 10}px`,
    width: `${Math.max(3, (aggregate.to - aggregate.from + 1) * scale.value - 2)}px`,
    height: `${LANE_H - 20}px`,
  }
}
function clockStyle(item: ClockItem) {
  const x = clockX(item.start)
  const width = item.end === null ? 0 : Math.max(3, clockX(item.end) - x)
  return item.end === null
    ? { left: `${x - 6}px`, top: `${laneTop(item.lane) + 13}px` }
    : { left: `${x}px`, top: `${laneTop(item.lane) + 9}px`, width: `${width}px`, height: `${LANE_H - 18}px` }
}
const dim = computed(() => !!selectedNode.value && !focusOnly.value)
function relationClass(key: string) {
  if (!dim.value) return ''
  if (key === store.selectedKey) return 'is-selected'
  const item = model.value.index.get(key)
  const related = item?.members.some(member => relatedKind.value.has(member.key))
  return related ? 'is-related' : 'is-dim'
}

const links = computed(() => {
  const from = selectedItem.value
  if (!from || mode.value !== 'order' || aggregated.value) return []
  const start = itemCenter(from)
  const seen = new Set<string>()
  const result: { key: string; d: string; kind: RelationKind }[] = []
  for (const relation of chain.value?.relations ?? []) {
    const target = model.value.index.get(relation.node.key)
    if (!target || target === from || seen.has(target.key) || !laneIndex.value.has(target.lane)) continue
    seen.add(target.key)
    const end = itemCenter(target)
    const bend = Math.max(24, Math.abs(end.x - start.x) / 3)
    result.push({
      key: target.key,
      kind: relation.kind,
      d: `M${start.x},${start.y} C${start.x + Math.sign(end.x - start.x || 1) * bend},${start.y} ${end.x - Math.sign(end.x - start.x || 1) * bend},${end.y} ${end.x},${end.y}`,
    })
  }
  return result
})

/* ── 跟随、定位与增量 ─────────────────────────────────── */
let anchor: { key: string; offset: number } | null = null
async function loadOlder() {
  const element = track.value
  const first = visibleItems.value[0] ?? model.value.items[visibleRange.value.from]
  if (element && first) anchor = { key: first.key, offset: first.column * scale.value - element.scrollLeft }
  store.follow = false
  await store.loadOlderHistory()
}
watch(
  () => model.value.columns,
  () => {
    if (anchor) {
      const item = model.value.index.get(anchor.key)
      const offset = anchor.offset
      anchor = null
      if (item) void nextTick(() => scrollTo(item.column * scale.value - offset))
      return
    }
    if (store.follow) scrollToEnd()
  },
)
watch(
  () => store.focusKey,
  key => {
    if (!key) return
    if (mode.value === 'clock' && centerClock(key)) return
    const item = model.value.index.get(key)
    if (item) {
      store.follow = false
      centerOn(item)
    } else if (allNodes.value.some(node => node.key === key))
      notice.value = '要定位的条目被当前筛选隐藏；清除筛选后可在时间线中看到它。'
    else notice.value = '要定位的条目不在已载入范围内，可先载入更早事件。'
  },
)
watch(mode, () => {
  if (mode.value === 'clock' && clock.value.available) {
    const span = Math.max(1, (clock.value.max - clock.value.min) / 1000)
    clockScale.value = Math.max(0.02, (view.value.width - 160) / span)
  }
  void nextTick(() => (store.follow ? scrollToEnd() : syncView()))
})
watch(focusOnly, () => void nextTick(() => centerOn(selectedItem.value)))
// 筛选或聚焦让画布变窄时，浏览器会悄悄收回 scrollLeft 而不一定触发 scroll；重新读取可见范围。
watch(contentWidth, () => void nextTick(syncView))

let observer: ResizeObserver | undefined
onMounted(() => {
  syncView()
  if (track.value) {
    observer = new ResizeObserver(syncView)
    observer.observe(track.value)
  }
  if (store.focusKey && model.value.index.has(store.focusKey)) centerOn(model.value.index.get(store.focusKey)!)
  else scrollToEnd()
})
onBeforeUnmount(() => observer?.disconnect())

const captureNote = computed(() => {
  if (store.preview) return ''
  const count = allNodes.value.filter(node => node.record).length
  if (count) return ''
  return store.captureEnabled
    ? '采集已开启，但已载入范围内还没有私有记录。'
    : '采集未开启：模型调用、决策、召回与裁定耗时没有记录，「角色处理」「规则裁定」泳道为空不代表没有发生；已提交事件仍完整显示。'
})
</script>

<template>
  <div class="cr-center tl-root">
    <!-- 工具栏 -->
    <div class="tl-toolbar" role="toolbar" aria-label="时间线工具栏">
      <div class="tl-seg" role="radiogroup" aria-label="时间轴模式">
        <button
          class="cr-tab"
          :class="{ active: mode === 'order' }"
          role="radio"
          :aria-checked="mode === 'order'"
          @click="mode = 'order'"
        >
          世界顺序
        </button>
        <button
          class="cr-tab"
          :class="{ active: mode === 'clock' }"
          role="radio"
          :aria-checked="mode === 'clock'"
          :disabled="!clock.available"
          :title="clock.available ? '只显示有墙钟时间的采集记录；已提交事件没有墙钟时间' : clock.reason"
          @click="mode = 'clock'"
        >
          实际耗时
        </button>
      </div>

      <details class="tl-pop">
        <summary class="cr-button">
          角色{{ filters.characterIds.length ? ` · ${filters.characterIds.length}` : '：全部' }}
        </summary>
        <div class="tl-pop-body">
          <label class="tl-check"
            ><input
              type="checkbox"
              :checked="!filters.characterIds.length"
              @change="setFilters({ characterIds: [] })"
            />全部</label
          >
          <label v-for="character in characters" :key="character.id" class="tl-check">
            <input
              type="checkbox"
              :checked="filters.characterIds.includes(character.id)"
              @change="setFilters({ characterIds: toggle(filters.characterIds, character.id) })"
            />{{ character.name }}
          </label>
        </div>
      </details>
      <details class="tl-pop">
        <summary class="cr-button">类型{{ filters.kinds.length ? ` · ${filters.kinds.length}` : '：全部' }}</summary>
        <div class="tl-pop-body">
          <label v-for="[kind, text] in kindOptions" :key="kind" class="tl-check">
            <input
              type="checkbox"
              :checked="filters.kinds.includes(kind)"
              @change="setFilters({ kinds: toggle(filters.kinds, kind) })"
            />
            <i class="tl-swatch" :class="`c-${CATEGORY[kind]}`" />{{ text }}
          </label>
        </div>
      </details>
      <details class="tl-pop">
        <summary class="cr-button">
          结果{{ filters.statuses.length ? ` · ${filters.statuses.length}` : '：全部' }}
        </summary>
        <div class="tl-pop-body">
          <label v-for="[status, meta] in statusOptions" :key="status" class="tl-check">
            <input
              type="checkbox"
              :checked="filters.statuses.includes(status)"
              @change="setFilters({ statuses: toggle(filters.statuses, status) })"
            />
            <span class="tl-icon" :class="`s-${status}`">{{ meta.icon }}</span
            >{{ meta.label }}
          </label>
        </div>
      </details>
      <input
        class="cr-input"
        :value="filters.search"
        placeholder="搜索已载入事件"
        aria-label="在已载入事件中搜索"
        @input="setFilters({ search: ($event.target as HTMLInputElement).value })"
      />
      <button
        class="cr-button"
        :class="{ primary: filters.abnormalOnly }"
        :aria-pressed="filters.abnormalOnly"
        @click="setFilters({ abnormalOnly: !filters.abnormalOnly })"
      >
        只看异常
      </button>
      <button
        class="cr-button"
        :disabled="!currentCharacter"
        :title="currentCharacter ? `只显示 ${store.label(currentCharacter)} 的事件` : '先选中一条带角色的事件'"
        @click="onlyCurrentCharacter"
      >
        只看当前角色
      </button>
      <details class="tl-pop">
        <summary class="cr-button" :class="{ primary: !filters.showSystem || systemCollapsed }">
          泳道{{ !filters.showSystem ? '：已隐藏系统' : systemCollapsed ? '：系统已折叠' : '' }}
        </summary>
        <div class="tl-pop-body">
          <label class="tl-check"
            ><input
              type="checkbox"
              :checked="filters.showSystem"
              @change="setFilters({ showSystem: !filters.showSystem })"
            />显示系统事件</label
          >
          <label class="tl-check"
            ><input
              type="checkbox"
              :checked="systemCollapsed"
              :disabled="!filters.showSystem"
              @change="systemCollapsed = !systemCollapsed"
            />系统泳道折叠为一条</label
          >
        </div>
      </details>
      <span class="cr-spacer tl-gap" />
      <button class="cr-button" :class="{ primary: store.follow }" :aria-pressed="store.follow" @click="followLatest">
        <ArrowRightToLine :size="13" />跟随最新
      </button>
      <button class="cr-button" :disabled="!store.selectedKey" @click="locateCurrent">
        <Crosshair :size="13" />定位当前
      </button>
      <button class="cr-button" @click="resetZoom"><RotateCcw :size="13" />重置缩放</button>
      <button
        class="cr-button"
        :disabled="store.loading"
        title="增量读取新事件，保留已载入内容与选中项"
        @click="store.poll()"
      >
        <RefreshCw :size="13" :class="{ 'cr-loading': store.loading }" />刷新
      </button>
    </div>

    <!-- 生效中的筛选 -->
    <div v-if="filterChips.length || serverScope || focusOnly" class="tl-chips">
      <span v-if="focusOnly" class="tl-chip strong">
        仅显示与 {{ selectedLabel }} 有确定关联的 {{ relatedKind.size }} 条
        <button class="cr-button tiny" @click="focusOnly = false"><Maximize2 :size="11" />返回完整视图</button>
      </span>
      <span v-for="chip in filterChips" :key="chip.key" class="tl-chip">
        {{ chip.label
        }}<button class="cr-icon-button" :aria-label="`清除 ${chip.label}`" @click="chip.clear()">
          <X :size="12" />
        </button>
      </span>
      <span v-if="serverScope" class="tl-chip warn" title="服务端筛选决定载入哪些事件；在顶部工具栏或左侧导航清除">
        载入范围：仅 {{ serverScope }}
      </span>
      <span v-if="hiddenCount && !focusOnly" class="tl-chip-note">已隐藏 {{ hiddenCount }} 条</span>
      <button v-if="filterChips.length" class="cr-button tiny" @click="clearFilters">清除全部筛选</button>
    </div>

    <p v-if="captureNote" class="cr-banner warn">{{ captureNote }}</p>
    <p v-if="mode === 'clock'" class="cr-banner">
      实际耗时：只显示带墙钟时间的采集记录（{{ clock.items.length }} 条），已提交事件没有墙钟时间，未显示
      {{ clock.omittedEvents }} 条。条形只画记录了耗时的调用，其余为瞬时标记。
    </p>
    <p v-if="store.pollError" class="cr-banner danger" role="alert">
      {{ store.pollError }}已载入内容保留。<button class="cr-button tiny" @click="store.poll()">重试</button>
    </p>
    <p v-if="notice" class="cr-banner">
      {{ notice }}<button class="cr-icon-button" aria-label="关闭提示" @click="notice = ''"><X :size="12" /></button>
    </p>

    <!-- 概览 -->
    <div ref="overviewRef" class="tl-overview" aria-label="已载入范围概览，点击或拖动跳转" @pointerdown="overviewJump">
      <div class="tl-overview-bars">
        <span
          v-for="(bucket, index) in overview"
          :key="index"
          class="tl-ob"
          :class="`s-${bucket.status}`"
          :style="{ height: `${bucket.height}%` }"
        />
      </div>
      <div class="tl-window-area"><div class="tl-window" :style="windowBox" /></div>
      <div class="tl-overview-legend">
        <span v-if="store.truncated">← 序号 {{ store.historyFloor }} 之前未载入</span>
        <span v-else>已从开头载入</span>
        <span>{{ model.items.length }} 块 / {{ shownNodes.length }} 条</span>
        <span>{{
          mode === 'clock'
            ? '墙钟时间'
            : aggregated
              ? '按世界刻聚合（块宽表示条数，不是时长）'
              : '单事件 · 列只表示先后'
        }}</span>
      </div>
    </div>

    <!-- 主体 -->
    <div class="tl-body">
      <div class="tl-corner">
        <button v-if="store.truncated" class="cr-button tiny" :disabled="store.busy" @click="loadOlder">
          载入更早
        </button>
        <span v-else class="cr-muted">泳道</span>
      </div>
      <div class="tl-ruler" aria-hidden="true">
        <div class="tl-ruler-inner" :style="{ width: `${contentWidth}px`, transform: `translateX(${-view.left}px)` }">
          <span v-for="mark in rulerTicks" :key="`t${mark.x}`" class="tl-mark major" :style="{ left: `${mark.x}px` }">{{
            mark.label
          }}</span>
          <span v-for="mark in seqMarks" :key="`s${mark.x}`" class="tl-mark seq" :style="{ left: `${mark.x}px` }">{{
            mark.label
          }}</span>
        </div>
      </div>
      <div class="tl-labels">
        <div class="tl-labels-inner" :style="{ transform: `translateY(${-view.top}px)` }">
          <div
            v-for="lane in lanes"
            :key="lane.id"
            class="tl-lane-label"
            :class="{ system: lane.system }"
            :style="{ height: `${LANE_H}px` }"
            :title="
              lane.system
                ? (SYSTEM_LANES.find(item => item.id === lane.id)?.hint ?? '系统泳道：模型、规则、世界与观察')
                : `${lane.label}${lane.player ? '（玩家）' : ''}`
            "
          >
            <span class="tl-lane-name">{{ lane.label }}</span>
            <span v-if="lane.player" class="cr-tag line">玩家</span>
            <span class="tl-lane-count">{{ laneCounts.get(lane.id) ?? 0 }}</span>
          </div>
        </div>
      </div>
      <div
        ref="track"
        class="tl-track"
        :class="{ dragging }"
        tabindex="0"
        aria-label="运行时间线：滚轮缩放，拖动平移，左右方向键切换选中事件"
        @scroll="onScroll"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @keydown="onKeydown"
      >
        <div class="tl-canvas" :style="{ width: `${contentWidth}px`, height: `${contentHeight}px` }">
          <div
            v-for="(lane, index) in lanes"
            :key="lane.id"
            class="tl-lane-row"
            :class="{ system: lane.system }"
            :style="{ top: `${index * LANE_H}px`, height: `${LANE_H}px` }"
          />
          <div
            v-for="band in tickBands"
            :key="band.key"
            class="tl-band"
            :style="{ left: `${band.x}px`, width: `${band.width}px` }"
          />

          <svg v-if="links.length" class="tl-links" :width="contentWidth" :height="contentHeight" aria-hidden="true">
            <path v-for="link in links" :key="link.key" :d="link.d" class="tl-link" :class="`r-${link.kind}`" />
          </svg>

          <template v-if="mode === 'order' && !aggregated">
            <button
              v-for="item in visibleItems"
              :key="item.key"
              class="tl-item"
              :class="[
                `c-${CATEGORY[item.node.kind]}`,
                `s-${item.status}`,
                relationClass(item.key),
                {
                  selected: item.members.some(member => member.key === store.selectedKey),
                  narrow: scale < LABEL_FROM,
                  process: item.node.processing,
                },
              ]"
              :style="itemStyle(item)"
              :title="itemTitle(item.node, item)"
              :aria-label="itemTitle(item.node, item)"
              @click="choose(item)"
            >
              <span class="tl-icon" :class="`s-${item.status}`">{{ STATUS_META[item.status].icon }}</span>
              <span v-if="scale >= LABEL_FROM" class="tl-text">{{ itemText(item) }}</span>
              <span v-if="item.members.length > 1 && scale >= 34" class="tl-count">{{ item.members.length }}</span>
            </button>
          </template>

          <template v-else-if="mode === 'order'">
            <button
              v-for="aggregate in aggregates"
              :key="aggregate.key"
              class="tl-item tl-agg"
              :class="[`c-${CATEGORY[aggregate.first.node.kind]}`, `s-${aggregate.status}`]"
              :style="aggregateStyle(aggregate)"
              :title="`tick ${aggregate.tick ?? '无'} · ${aggregate.count} 条（宽度表示条数，不是时长）\n最严重结果：${STATUS_META[aggregate.status].label}\n点击放大到单事件`"
              @click="zoomInto(aggregate)"
            >
              <span v-if="(aggregate.to - aggregate.from + 1) * scale > 22" class="tl-count">{{
                aggregate.count
              }}</span>
            </button>
          </template>

          <template v-else>
            <button
              v-for="item in clockItems"
              :key="item.key"
              class="tl-item"
              :class="[
                `c-${CATEGORY[item.node.kind]}`,
                `s-${clockStatus(item)}`,
                item.end === null ? 'tl-instant' : 'tl-bar',
                { selected: item.key === store.selectedKey },
              ]"
              :style="clockStyle(item)"
              :title="`${itemTitle(item.node)}\n开始：${timeLabel(new Date(item.start).toISOString())}${item.end === null ? '（瞬时标记，无耗时记录）' : `\n耗时：${Math.round(item.end - item.start)}ms`}`"
              @click="chooseNode(item.node)"
            >
              <span v-if="item.end !== null && clockX(item.end) - clockX(item.start) > 70" class="tl-text"
                >{{ store.label(item.node.characterId) }}：{{ item.node.summary }}</span
              >
            </button>
          </template>
        </div>
        <div v-if="!lanes.length || !(mode === 'clock' ? clock.items.length : model.items.length)" class="tl-empty">
          <template v-if="!allNodes.length"
            >尚未载入事件。{{ store.busy ? '正在读取…' : '确认游戏仍在运行后点击刷新。' }}</template
          >
          <template v-else-if="mode === 'clock'">没有带墙钟时间的采集记录。</template>
          <template v-else
            >当前筛选隐藏了全部 {{ allNodes.length }} 条。<button class="cr-button tiny" @click="clearFilters">
              清除筛选
            </button></template
          >
        </div>
      </div>
    </div>

    <!-- 底部图例与链路摘要 -->
    <div class="tl-foot">
      <span
        v-for="[category, text] in [
          ['speak', '发言'],
          ['move', '移动'],
          ['action', '行动/裁定'],
          ['model', '处理/模型'],
          ['state', '状态/物品'],
          ['activity', '活动'],
          ['observe', '观察'],
          ['world', '世界刻'],
        ]"
        :key="category"
        class="tl-legend"
      >
        <i class="tl-swatch" :class="`c-${category}`" />{{ text }}
      </span>
      <span class="tl-legend">✓ 通过 ✗ 拒绝 ! 失败 ⏸ 中断 … 处理中 · 已提交</span>
      <span class="cr-spacer" />
      <template v-if="selectedNode">
        <span class="tl-legend">
          {{ selectedLabel }}：确定关联 {{ relatedKind.size }} 条
          <template v-for="(meta, kind) in RELATION_META" :key="kind">
            <i class="tl-line" :class="`r-${kind}`" />{{ meta.label }}
          </template>
        </span>
        <button v-if="!focusOnly" class="cr-button tiny" :disabled="!relatedKind.size" @click="focusOnly = true">
          仅看此链路
        </button>
        <button v-else class="cr-button tiny" @click="focusOnly = false">返回完整视图</button>
      </template>
      <span v-else class="tl-legend">点击事件查看详情与确定关联；不画仅凭时间相邻的关系</span>
      <span v-if="store.added > 0 && !store.follow" class="tl-legend warn">新增 {{ store.added }} 条</span>
    </div>
  </div>
</template>
