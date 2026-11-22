<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { EditorChoice, EditorGraph, LayoutNode } from '../../../host/src/editor/activity-graph.ts'
const props = defineProps<{
  graph: EditorGraph
  scope: string
  selected: string
  describe: (c: EditorChoice['condition']) => string
}>()
const emit = defineEmits<{
  select: [id: string]
  enter: [id: string]
  group: [id: string]
  move: [id: string, x: number, y: number]
}>()
const zoom = ref(1),
  viewport = ref<HTMLDivElement>()
const layout = computed(() => new Map((props.graph.layout ?? []).map(n => [n.id, n])))
const trail = computed(() => {
  const out: LayoutNode[] = []
  let node = layout.value.get(props.scope)
  while (node) {
    out.unshift(node)
    node = node.parent ? layout.value.get(node.parent) : undefined
  }
  return out
})
const nodes = computed(() => {
  const groupRows = [...layout.value.values()].filter(n => n.title)
  const input = [
    { id: 'start', title: props.graph.title, detail: props.graph.opening || '编辑开场', kind: '开场', end: '' },
    ...groupRows.map(n => ({ id: n.id, title: n.title!, detail: '进入子流程 →', kind: '子流程', end: '' })),
    ...props.graph.choices.map(c => ({
      id: c.id,
      title: c.label,
      detail: props.describe(c.condition),
      kind: '玩家选项',
      end: c.next === 'end' ? '回到日常' : '留在本活动',
    })),
  ].filter(n => (layout.value.get(n.id)?.parent ?? '') === props.scope)
  let branch = 0
  return input.map(n => {
    const l = layout.value.get(n.id),
      start = n.id === 'start'
    const y = start ? 110 : 44 + branch++ * 144
    return { ...n, x: l?.x ?? (start ? 44 : 346), y: l?.y ?? y }
  })
})
const origin = computed(() => nodes.value.find(n => n.id === 'start') ?? { x: 32, y: 72 })
const width = computed(() => Math.max(680, ...nodes.value.map(n => n.x + 280)))
const height = computed(() => Math.max(400, ...nodes.value.map(n => n.y + 135)))
function wire(n: (typeof nodes.value)[number]) {
  const x = origin.value.x + (props.scope ? 94 : 210),
    y = origin.value.y + (props.scope ? 16 : 49)
  const mid = (x + n.x) / 2
  return 'M ' + x + ' ' + y + ' C ' + mid + ' ' + y + ' ' + mid + ' ' + (n.y + 49) + ' ' + n.x + ' ' + (n.y + 49)
}
watch(
  () => [props.graph.key, props.scope],
  () => {
    viewport.value?.scrollTo(0, 0)
  },
)
let drag: { id: string; pid: number; x: number; y: number; startX: number; startY: number; moved: boolean } | undefined
let ignoreClick = false
function down(e: PointerEvent, n: (typeof nodes.value)[number]) {
  if (e.button !== 0) return
  ignoreClick = false
  drag = { id: n.id, pid: e.pointerId, x: n.x, y: n.y, startX: e.clientX, startY: e.clientY, moved: false }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function moving(e: PointerEvent) {
  if (!drag || drag.pid !== e.pointerId) return
  const dx = e.clientX - drag.startX,
    dy = e.clientY - drag.startY
  if (!drag.moved && Math.hypot(dx, dy) < 5) return
  drag.moved = true
  const bound = (v: number) => Math.max(0, Math.min(12000, Math.round(v)))
  emit('move', drag.id, bound(drag.x + dx / zoom.value), bound(drag.y + dy / zoom.value))
}
function finish() {
  ignoreClick = !!drag?.moved
  drag = undefined
}
function nudge(e: KeyboardEvent, n: (typeof nodes.value)[number]) {
  if (!e.shiftKey) return
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-12, 0],
    ArrowRight: [12, 0],
    ArrowDown: [0, 12],
    ArrowUp: [0, -12],
  }
  const step = moves[e.key]
  if (!step) return
  e.preventDefault()
  emit('move', n.id, Math.max(0, Math.min(12000, n.x + step[0])), Math.max(0, Math.min(12000, n.y + step[1])))
}
function open(id: string, group: boolean, e: MouseEvent) {
  if (ignoreClick && e.detail) {
    ignoreClick = false
    return
  }
  if (group) emit('enter', id)
  else emit('select', id)
}
</script>
<template>
  <section class="sheet" aria-label="活动流程图">
    <nav class="path" aria-label="流程层级">
      <button @click="emit('enter', '')">主流程</button>
      <template v-for="g in trail" :key="g.id"
        ><span>›</span><button @click="emit('enter', g.id)">{{ g.title }}</button></template
      >
      <button v-if="scope" class="manage" @click="emit('group', scope)">编辑子流程</button>
    </nav>
    <div class="viewport" ref="viewport" tabindex="0" aria-label="流程画布">
      <div :style="{ width: width * zoom + 'px', height: height * zoom + 'px' }" class="extent">
        <div class="plane" :style="{ width: width + 'px', height: height + 'px', transform: 'scale(' + zoom + ')' }">
          <svg :width="width" :height="height" aria-hidden="true">
            <path v-for="n in nodes.filter(r => r.id !== 'start')" :key="n.id" :d="wire(n)" />
          </svg>
          <button v-if="scope" class="port" @click="emit('enter', trail.at(-1)?.parent ?? '')">← 上层流程</button>
          <button
            v-for="n in nodes"
            :key="n.id"
            class="node"
            :class="{ group: n.kind === '子流程', opening: n.id === 'start' }"
            :style="{ left: n.x + 'px', top: n.y + 'px' }"
            :aria-pressed="selected === n.id"
            title="点击打开，拖动或按 Shift 和方向键移动"
            @keydown="nudge($event, n)"
            @pointerdown="down($event, n)"
            @pointermove="moving"
            @pointerup="finish"
            @pointercancel="finish"
            @click="open(n.id, n.kind === '子流程', $event)"
          >
            <small>{{ n.kind }}</small
            ><strong>{{ n.title }}</strong
            ><span>{{ n.detail }}</span
            ><small v-if="n.end">↳ {{ n.end }}</small>
          </button>
        </div>
      </div>
    </div>
    <div class="scale">
      <button aria-label="缩小画布" :disabled="zoom <= 0.5" @click="zoom -= 0.25">−</button
      ><button aria-label="还原画布缩放" @click="zoom = 1">{{ zoom * 100 }}%</button
      ><button aria-label="放大画布" :disabled="zoom >= 2" @click="zoom += 0.25">＋</button>
    </div>
  </section>
</template>
<style scoped>
.sheet {
  position: absolute;
  inset: 0;
  background: #fafafa;
  color: #242424;
}
.path {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 22px;
  background: white;
  border-bottom: 1px solid #ddd;
  min-height: 40px;
  box-sizing: border-box;
}
.path button,
.scale button,
.port {
  background: white;
  border: 1px solid #ccc;
  border-radius: 3px;
  cursor: pointer;
  padding: 4px 9px;
  color: inherit;
  font: inherit;
}
.path button {
  border-color: transparent;
}
.path .manage {
  border-color: #ccc;
  margin-left: 10px;
}
.viewport {
  position: absolute;
  inset: 42px 0 0;
  overflow: auto;
  background-image: radial-gradient(#d9d9d9 0.85px, transparent 0.85px);
  background-size: 15px 15px;
}
.extent {
  overflow: hidden;
}
.plane {
  position: relative;
  transform-origin: 0 0;
}
svg {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
path {
  fill: none;
  stroke: #898989;
  stroke-width: 1.6;
}
.node {
  position: absolute;
  width: 210px;
  min-height: 98px;
  box-sizing: border-box;
  display: grid;
  align-content: center;
  gap: 3px;
  text-align: left;
  background: white;
  color: #222;
  border: 1px solid #aaa;
  border-radius: 5px;
  padding: 9px 14px;
  cursor: grab;
  touch-action: none;
  font: inherit;
  user-select: none;
}
.node:active {
  cursor: grabbing;
}
.node[aria-pressed='true'] {
  outline: 2px solid #242424;
}
.node small {
  color: #595959;
  font-size: 11px;
}
.node strong,
.node span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node span {
  font-size: 12px;
}
.node strong {
  font-size: 15px;
}
.group {
  border-left: 4px double #333;
}
.opening {
  border-top: 3px solid #2b2b2b;
}
.port {
  position: absolute;
  left: 32px;
  top: 72px;
}
.scale {
  position: absolute;
  bottom: 16px;
  left: 16px;
  display: flex;
  background: white;
}
.scale button {
  border-radius: 0;
}
.scale button + button {
  border-left: 0;
}
</style>
