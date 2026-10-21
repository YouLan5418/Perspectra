<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ArrowDownToLine } from '@lucide/vue'
import type { InspectedRequest } from '@harness-world/provider-chat'
import { asRecord, durationLabel, KIND_LABEL, timeLabel } from './format.ts'
import type { ConversationEntry, TraceNode } from './model.ts'
import { useCreatorStore } from './store.ts'

const store = useCreatorStore()
const scroller = ref<HTMLElement | null>(null)

const entries = computed(() => store.conversation)

function followLatest() {
  store.follow = true
  scrollToEnd()
}

function requestOf(node: TraceNode | undefined): InspectedRequest | null {
  if (!node?.recordId) return null
  return (store.details[node.recordId]?.data as InspectedRequest | undefined) ?? null
}

/** 模型思考、工具调用与召回始终折叠展示；上下文、决策、轮次随「显示处理过程」展开。 */
const ALWAYS = new Set(['model', 'recall'])
function chain(entry: ConversationEntry): TraceNode[] {
  const always = entry.process.filter(node => ALWAYS.has(node.kind))
  const others = store.showProcess ? entry.process.filter(node => !ALWAYS.has(node.kind)) : []
  return [...others, ...always]
}

function thinkingOf(node: TraceNode) {
  const response = requestOf(node)?.response
  if (!response) return null
  if (!response.thinking.length) return response.thinkingStatus === 'not_provided' ? [] : null
  return response.thinking
}
function thinkingLabel(node: TraceNode): string {
  const thinking = thinkingOf(node)
  if (!thinking?.length) return '服务未返回思考'
  return thinking.every(item => item.kind === 'summary') ? '思考摘要（服务返回）' : '服务返回的思考'
}
function toolsOf(node: TraceNode) {
  return requestOf(node)?.response?.toolCalls ?? []
}
function modelTime(node: TraceNode): string {
  return timeLabel(requestOf(node)?.startedAt)
}

function audience(node: TraceNode) {
  const item = node.history
  if (!item) return []
  const data = asRecord(item.event.data)
  const addressees = Array.isArray(data.addresseeIds)
    ? data.addresseeIds.filter((id): id is string => typeof id === 'string')
    : []
  // 事件行为者自己的观察不算听众。
  const others = item.recipients.filter(recipient => recipient.characterId !== node.characterId)
  const full = others.filter(recipient => recipient.visibility === 'full')
  const occurrence = others.filter(recipient => recipient.visibility === 'occurrence_only')
  return [
    ...addressees.map(id => ({ tone: 'accent' as const, text: `对 ${store.label(id)} 说` })),
    ...(full.length
      ? [{ tone: 'ok' as const, text: `完整观察 ${full.map(r => store.label(r.characterId)).join('、')}` }]
      : []),
    ...(occurrence.length
      ? [{ tone: 'muted' as const, text: `仅知发生 ${occurrence.map(r => store.label(r.characterId)).join('、')}` }]
      : []),
  ]
}

function initial(name: string): string {
  return name.slice(0, 1)
}

/** 合并观察行：一位观察者显示名字，多位显示人数，名单放在副文本。 */
function rowActor(entry: ConversationEntry): string {
  const members = entry.members ?? []
  if (members.length > 1) return `${members.length} 位观察者`
  return store.label(entry.node!.characterId) || '世界'
}
function rowDetail(entry: ConversationEntry): string {
  const members = entry.members ?? []
  if (members.length > 1) return members.map(node => store.label(node.characterId)).join('、')
  return entry.node!.detail
}

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
  () => entries.value.length,
  count => {
    if (store.follow && count !== lastCount.value) scrollToEnd()
    lastCount.value = count
  },
)
onMounted(() => {
  if (store.follow) scrollToEnd()
})
</script>

<template>
  <div class="cr-center">
    <div ref="scroller" class="cr-scroll">
      <div v-if="!entries.length" class="cr-empty">
        没有可显示的对话。{{
          store.captureEnabled ? '等待角色互动，或调整筛选条件。' : '模型调用与思考需要先开启采集。'
        }}
      </div>
      <div v-else class="cr-conversation">
        <template v-for="entry in entries" :key="entry.key">
          <!-- 未发表的处理过程：默认收起，展开后按紧凑条目阅读 -->
          <div v-if="entry.kind === 'process'" class="cr-process" style="margin-left: 0">
            <button
              v-for="node in entry.process"
              :key="node.key"
              class="cr-process-row"
              :class="{ selected: store.selectedKey === node.key }"
              :data-key="node.key"
              @click="store.selectNode(node)"
            >
              <span class="cr-kind" :class="node.tone">{{ KIND_LABEL[node.kind] }}</span>
              <strong class="cr-compact-actor">{{ store.label(node.characterId) || '世界' }}</strong>
              <span class="cr-compact-main">{{ node.summary }}</span>
              <span class="cr-tag line">{{ node.statusLabel }}</span>
              <span v-if="node.durationMs !== undefined" class="cr-cell-num">{{ durationLabel(node.durationMs) }}</span>
            </button>
          </div>

          <article
            v-else-if="entry.kind === 'message'"
            class="cr-message"
            :class="{ selected: store.selectedKey === entry.key }"
            :data-key="entry.key"
            tabindex="0"
            @click="store.selectNode(entry.node!)"
            @keydown.enter="store.selectNode(entry.node!)"
          >
            <div v-if="chain(entry).length" class="cr-process">
              <template v-for="node in chain(entry)" :key="node.key">
                <button
                  v-if="node.kind !== 'model'"
                  class="cr-process-row"
                  :class="{ selected: store.selectedKey === node.key }"
                  @click.stop="store.selectNode(node)"
                >
                  <span class="cr-kind" :class="node.tone">{{ KIND_LABEL[node.kind] }}</span>
                  <span class="cr-compact-main">{{ node.summary }}</span>
                  <span class="cr-tag line">{{ node.statusLabel }}</span>
                </button>
                <details v-else class="cr-thought" :data-key="node.key" @click.stop>
                  <summary>
                    <span class="cr-kind accent" style="margin-right: 6px">模型</span>
                    {{ thinkingLabel(node) }}<span v-if="modelTime(node)"> · {{ modelTime(node) }}</span> ·
                    {{ node.durationMs === undefined ? node.statusLabel : durationLabel(node.durationMs) }}
                  </summary>
                  <pre v-for="(item, index) in thinkingOf(node) ?? []" :key="index">{{ item.text }}</pre>
                  <p v-if="!thinkingOf(node)?.length" style="margin: 6px 0 0; color: var(--cr-faint)">
                    服务未返回思考；不还原未返回内容。
                  </p>
                  <div v-if="toolsOf(node).length" class="cr-tools">
                    <span v-for="(call, index) in toolsOf(node)" :key="index" class="cr-tag warn"
                      >工具 {{ call.name }} · {{ JSON.stringify(call.arguments).slice(0, 60) }}</span
                    >
                  </div>
                  <p style="margin: 6px 0 0">
                    <button class="cr-button tiny" @click.stop="store.selectNode(node)">查看这次调用</button>
                  </p>
                </details>
              </template>
            </div>

            <div class="cr-message-head">
              <span class="cr-avatar">{{ initial(store.label(entry.node!.characterId)) }}</span>
              <strong>{{ store.label(entry.node!.characterId) }}</strong>
              <span>序号 #{{ entry.node!.seq }} · tick {{ entry.node!.tick }}</span>
              <span v-if="entry.node!.history" class="cr-tag line">{{ entry.node!.statusLabel }}</span>
              <span class="cr-audience">
                <span v-for="(tag, index) in audience(entry.node!)" :key="index" class="cr-tag" :class="tag.tone">{{
                  tag.text
                }}</span>
              </span>
            </div>
            <p class="cr-message-body">
              <template v-if="entry.node!.segments?.length">
                <span
                  v-for="(segment, index) in entry.node!.segments"
                  :key="index"
                  :class="segment.type === 'narration' ? 'cr-narration' : 'cr-speech'"
                  >{{ segment.text }}</span
                >
              </template>
              <template v-else>{{ entry.node!.summary }}</template>
            </p>
          </article>

          <div
            v-else-if="entry.node!.kind === 'world'"
            class="cr-divider"
            :data-key="entry.node!.key"
            @click="store.selectNode(entry.node!)"
          >
            <span>{{ entry.node!.summary }}</span>
          </div>

          <div
            v-else
            class="cr-compact"
            :class="{ selected: store.selectedKey === entry.node!.key }"
            :data-key="entry.node!.key"
            tabindex="0"
            @click="store.selectNode(entry.node!)"
            @keydown.enter="store.selectNode(entry.node!)"
          >
            <span class="cr-kind" :class="entry.node!.tone">{{ KIND_LABEL[entry.node!.kind] }}</span>
            <strong class="cr-compact-actor">{{ rowActor(entry) }}</strong>
            <span class="cr-compact-main" :title="entry.node!.summary">{{ entry.node!.summary }}</span>
            <span v-if="rowDetail(entry)" class="cr-cell-sub" :title="rowDetail(entry)">{{ rowDetail(entry) }}</span>
            <span class="cr-tag" :class="entry.node!.tone">{{ entry.node!.statusLabel }}</span>
            <span v-if="entry.node!.durationMs !== undefined" class="cr-cell-num">{{
              durationLabel(entry.node!.durationMs)
            }}</span>
          </div>
        </template>
      </div>
    </div>

    <Transition name="notice-fade">
      <button v-if="!store.follow && store.added > 0" class="cr-button primary cr-new" @click="followLatest">
        <ArrowDownToLine :size="13" />新增 {{ store.added }} 条
      </button>
    </Transition>
  </div>
</template>
