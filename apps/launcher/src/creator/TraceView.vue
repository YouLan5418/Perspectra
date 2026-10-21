<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowDownToLine } from '@lucide/vue'
import { durationLabel, KIND_LABEL } from './format.ts'
import { useCreatorStore } from './store.ts'
import type { TraceNode } from './types.ts'

const store = useCreatorStore()
const scroller = ref<HTMLElement | null>(null)
const buckets = 56

const nodes = computed(() => store.visibleTrace)

interface Bucket {
  index: number
  count: number
  tone: string
  key: string
}
/** 概览只覆盖已载入的序号区间，空段也保留一条可见基线。 */
const domain = computed(() => {
  const seqs = store.trace.map(node => node.sortSeq).filter(seq => Number.isFinite(seq) && seq > 0)
  const min = seqs.length ? Math.min(...seqs) : store.historyFloor
  return { min: Math.floor(min), max: Math.max(Math.floor(min) + 1, store.world?.headSeq ?? Math.floor(min) + 1) }
})
const overview = computed<Bucket[]>(() => {
  const { min, max } = domain.value
  const span = Math.max(1, max - min)
  const result: Bucket[] = Array.from({ length: buckets }, (_, index) => ({ index, count: 0, tone: 'muted', key: '' }))
  const position = (seq: number) => Math.min(buckets - 1, Math.max(0, Math.floor(((seq - min) / span) * buckets)))
  for (const node of store.trace) {
    const bucket = result[position(node.sortSeq)]!
    bucket.count += 1
    if (node.tone === 'danger') bucket.tone = 'fail'
    else if (node.tone === 'warn' && bucket.tone !== 'fail') bucket.tone = 'action'
    else if (bucket.tone === 'muted' && node.history) bucket.tone = 'event'
  }
  for (const node of nodes.value) {
    const bucket = result[position(node.sortSeq)]!
    if (!bucket.key) bucket.key = node.key
  }
  return result
})
const maxCount = computed(() => Math.max(1, ...overview.value.map(bucket => bucket.count)))
const selectedBucket = computed(() => {
  const node = store.selection?.node
  if (!node) return -1
  const { min, max } = domain.value
  return Math.min(buckets - 1, Math.max(0, Math.floor(((node.sortSeq - min) / Math.max(1, max - min)) * buckets)))
})

const failures = computed(() => store.trace.filter(node => node.tone === 'danger').length)

function scrollToEnd() {
  void nextTick(() => {
    const element = scroller.value
    if (element) element.scrollTop = element.scrollHeight
  })
}
defineExpose({ scrollToEnd })

watch(
  () => store.focusKey,
  key => {
    if (!key) return
    void nextTick(() => {
      const target = scroller.value?.querySelector(`[data-key="${CSS.escape(key)}"]`)
      if (target) (target as HTMLElement).scrollIntoView({ block: 'center' })
    })
  },
)
const lastCount = ref(0)
watch(
  () => nodes.value.length,
  count => {
    if (store.follow && count !== lastCount.value) scrollToEnd()
    lastCount.value = count
  },
)
function followLatest() {
  store.follow = true
  scrollToEnd()
}

function jump(bucket: Bucket) {
  if (bucket.key) store.focus(bucket.key)
}
function rowKey(node: TraceNode) {
  return node.key
}
</script>

<template>
  <div class="cr-center">
    <div class="cr-overview" aria-label="时间概览">
      <div class="cr-overview-bars">
        <button
          v-for="bucket in overview"
          :key="bucket.index"
          class="cr-overview-bar"
          :class="[
            bucket.tone === 'fail'
              ? 'has-fail'
              : bucket.tone === 'action'
                ? 'has-action'
                : bucket.tone === 'event'
                  ? 'has-event'
                  : '',
            { viewport: bucket.index === selectedBucket },
          ]"
          :style="{ height: `${Math.max(6, (bucket.count / maxCount) * 100)}%` }"
          :title="`第 ${bucket.index + 1} 段 · ${bucket.count} 条`"
          @click="jump(bucket)"
        />
      </div>
      <div class="cr-overview-legend">
        <span><b>时间概览</b> 序号 {{ domain.min }} – {{ domain.max }}</span>
        <span v-if="store.truncated">已载入最近一段，可向前载入更早</span>
        <span v-if="failures">失败或被拒绝 {{ failures }} 条</span>
        <span>{{ nodes.length }} 条可见 / {{ store.trace.length }} 条已载入</span>
      </div>
    </div>

    <div ref="scroller" class="cr-scroll">
      <div v-if="store.truncated" class="cr-banner">
        <span>更早的已提交事件尚未载入（当前起点序号 {{ store.historyFloor + 1 }}）。</span>
        <button class="cr-button tiny" :disabled="store.busy" @click="store.loadOlderHistory()">载入更早事件</button>
        <button
          v-if="store.recordFloor > 0"
          class="cr-button tiny"
          :disabled="store.busy"
          @click="store.loadOlderRecords()"
        >
          载入更早记录
        </button>
      </div>

      <div v-if="!nodes.length" class="cr-empty">
        没有符合条件的轨迹。{{
          store.showProcess ? '试试放宽筛选条件。' : '未发表的处理过程需要通过「显示处理过程」展开。'
        }}
      </div>

      <template v-else>
        <div class="cr-table-head">
          <span>类型</span><span>角色</span><span>调用／事件摘要</span><span>结果</span
          ><span style="text-align: right">耗时 / 序号</span>
        </div>
        <div
          v-for="node in nodes"
          :key="rowKey(node)"
          class="cr-row"
          :class="{ selected: store.selectedKey === node.key, processing: node.processing }"
          :data-key="node.key"
          tabindex="0"
          @click="store.selectNode(node)"
          @keydown.enter="store.selectNode(node)"
        >
          <span class="cr-kind" :class="node.tone">{{ KIND_LABEL[node.kind] }}</span>
          <span class="cr-cell-main" :title="store.label(node.characterId)">{{
            store.label(node.characterId) || '世界'
          }}</span>
          <span class="cr-cell-main">
            {{ node.summary }}
            <span v-if="node.detail" class="cr-cell-sub">{{ node.detail }}</span>
          </span>
          <span class="cr-cell-status"
            ><span class="cr-tag" :class="node.tone">{{ node.statusLabel }}</span></span
          >
          <span class="cr-cell-num">{{
            node.durationMs !== undefined
              ? durationLabel(node.durationMs)
              : node.seq !== undefined
                ? `#${node.seq}`
                : '—'
          }}</span>
        </div>
      </template>
    </div>

    <Transition name="notice-fade">
      <button v-if="!store.follow && store.added > 0" class="cr-button primary cr-new" @click="followLatest">
        <ArrowDownToLine :size="13" />新增 {{ store.added }} 条
      </button>
    </Transition>
  </div>
</template>
