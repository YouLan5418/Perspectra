<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { InspectorSnapshot } from '../../../../packages/provider-chat/src/request-inspector.ts'
import { useCreatorStore } from './store.ts'

/** 原启动器“请求探查”对话框，迁入创作者页面作为一个视图；读写都经过同一数据源。 */
const store = useCreatorStore()
const snapshot = ref<InspectorSnapshot>(),
  selected = ref<number>(),
  busy = ref(false),
  error = ref(''),
  notice = ref('')
const actor = ref(''),
  search = ref(''),
  tab = ref<'messages' | 'context' | 'body'>('messages'),
  automatic = ref(true),
  followLatest = ref(true)
let epoch = 0,
  timer: ReturnType<typeof setInterval> | undefined
const label = (id: string) => store.meta.characters.find(c => c.id === id)?.name ?? id
const actors = computed(() => [...new Set(snapshot.value?.requests.map(r => r.characterId) ?? [])])
const requests = computed(
  () => snapshot.value?.requests.filter(r => !actor.value || r.characterId === actor.value) ?? [],
)
const current = computed(() => requests.value.find(r => r.id === selected.value))
const matches = (text: string) => !search.value || text.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())
const messages = computed(
  () =>
    current.value?.messages
      .map((m, index) => ({ ...m, index }))
      .filter(m => matches(m.content + ' ' + m.source.name + ' ' + (m.source.original ?? ''))) ?? [],
)
const parts = computed(() => current.value?.contextParts.filter(p => matches(p.name + ' ' + p.content)) ?? [])
const partNames: Record<string, string> = {
  character: '当前角色',
  stimulus: '本次刺激',
  memories: '记忆',
  cognition: '认知',
  scene: '当前场景',
  observations: '可见观察',
  selfObservations: '自身观察',
  claims: '认识与声明',
  goals: '目标',
  items: '物品',
  affordances: '可用行动',
}

async function refresh(enabled?: boolean) {
  if (busy.value) return
  const ticket = ++epoch
  busy.value = true
  error.value = ''
  try {
    const next = await store.inspectRequests(enabled)
    if (ticket !== epoch) return
    snapshot.value = next
    if (actor.value && !actors.value.includes(actor.value)) actor.value = ''
    if (followLatest.value || !requests.value.some(r => r.id === selected.value))
      selected.value = requests.value.at(-1)?.id
  } catch {
    if (ticket === epoch) error.value = '读取失败，请确认游戏仍在运行。'
  } finally {
    if (ticket === epoch) busy.value = false
  }
}
function latest() {
  followLatest.value = true
  selected.value = requests.value.at(-1)?.id
}
watch(actor, latest)
onMounted(() => {
  void refresh()
  timer = setInterval(() => {
    if (automatic.value && snapshot.value?.enabled && !busy.value) void refresh()
  }, 3000)
})
onBeforeUnmount(() => {
  epoch++
  if (timer) clearInterval(timer)
})
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    notice.value = '已复制。'
  } catch {
    notice.value = '复制未完成，可在正文中选中文本复制。'
  }
}
</script>

<template>
  <section class="cr-requests" aria-label="模型请求">
    <div class="cr-req-bar">
      <strong>{{ snapshot?.enabled ? '正在采集' : '采集未启用' }} · {{ snapshot?.requests.length ?? 0 }}/4 条</strong>
      <button class="cr-button" :disabled="busy || !snapshot" @click="refresh(!snapshot?.enabled)">
        {{ snapshot?.enabled ? '停止并清空' : '启用采集' }}
      </button>
      <button class="cr-button" :disabled="busy" @click="refresh()">刷新</button>
      <button class="cr-button" :disabled="busy || !snapshot?.requests.length" @click="refresh(snapshot?.enabled)">
        清空记录
      </button>
      <label><input v-model="automatic" type="checkbox" /> 自动刷新（3 秒）</label>
    </div>
    <p class="cr-req-hint">
      展示最近 4
      次调用；启用后完整记录保存在本地创作者档案。停止采集或清空只清理临时视图，已保存历史保留。私有内容不进入游戏前端。
    </p>
    <p v-if="error" class="cr-banner danger" role="alert">{{ error }}</p>
    <p v-if="notice" class="cr-req-hint" role="status">{{ notice }}</p>
    <p v-if="snapshot && !snapshot.requests.length" class="cr-req-hint">
      {{ snapshot.enabled ? '等待角色互动。进行一次游戏互动后，这里会更新。' : '启用采集后，再进行一次角色互动。' }}
    </p>
    <div v-if="snapshot?.requests.length" class="cr-req-bar">
      <label
        >角色<select v-model="actor">
          <option value="">全部角色</option>
          <option v-for="id in actors" :key="id" :value="id">{{ label(id) }}</option>
        </select></label
      >
      <label
        >调用<select v-model="selected" @change="followLatest = false">
          <option v-for="request in requests" :key="request.id" :value="request.id">
            #{{ request.id }} · {{ label(request.characterId) }} · {{ request.continuation ? '继续处理' : '新刺激' }} ·
            {{ request.status }}
          </option>
        </select></label
      >
      <button class="cr-button" @click="latest">{{ followLatest ? '跟随最新调用' : '切回最新调用' }}</button>
    </div>
    <template v-if="current">
      <div class="cr-req-summary">
        <strong>{{ label(current.characterId) }}</strong>
        <span>{{ current.model }} · {{ current.durationMs ?? '…' }} ms · {{ current.status }}</span>
        <small>{{ current.startedAt }}</small>
        <span
          >服务计数：输入 {{ current.usage?.inputTokens ?? '未提供' }} / 输出
          {{ current.usage?.outputTokens ?? '未提供' }} / 合计 {{ current.usage?.totalTokens ?? '未提供' }}</span
        >
        <span
          >请求 JSON 估算 {{ current.estimatedBodyTokens }} token（其中工具 {{ current.estimatedToolTokens }}）。</span
        >
      </div>
      <p class="cr-req-hint">
        本地估算不等于模型 tokenizer 计数；服务 total 可能包含其他计数。ok 表示传输成功，不代表决策通过 Core 校验。
      </p>
      <div class="cr-req-bar">
        <button class="cr-button" :aria-pressed="tab === 'messages'" @click="tab = 'messages'">
          消息 {{ current.messages.length }}
        </button>
        <button class="cr-button" :aria-pressed="tab === 'context'" @click="tab = 'context'">
          上下文分项 {{ current.contextParts.length }}
        </button>
        <button class="cr-button" :aria-pressed="tab === 'body'" @click="tab = 'body'">完整请求 JSON</button>
        <input
          v-if="tab !== 'body'"
          v-model="search"
          class="cr-req-search"
          placeholder="查找名称或正文"
          aria-label="查找请求内容"
        />
      </div>
      <p v-if="current.omitted" class="cr-req-hint">{{ current.omitted }}</p>
      <div v-if="tab === 'messages'">
        <p v-if="!messages.length" class="cr-req-hint">没有匹配的消息。</p>
        <details v-for="message in messages" :key="message.index" :open="message.source.source !== 'context'">
          <summary>
            {{ message.index + 1 }}. {{ message.source.name }} · {{ message.role }} · 估算
            {{ message.estimatedTokens }} token
          </summary>
          <button class="cr-button tiny" @click="copy(message.content)">复制消息</button>
          <details v-if="message.source.original !== undefined">
            <summary>预设原文{{ message.source.macroExpanded ? '（已展开宏）' : '' }}</summary>
            <pre>{{ message.source.original }}</pre>
          </details>
          <pre>{{ message.content }}</pre>
        </details>
      </div>
      <div v-else-if="tab === 'context'">
        <p v-if="!parts.length" class="cr-req-hint">没有匹配的上下文分项。</p>
        <details v-for="part in parts" :key="part.name">
          <summary>
            {{ partNames[part.name] ?? part.name }} · {{ part.name }} · 估算 {{ part.estimatedTokens }} token
          </summary>
          <button class="cr-button tiny" @click="copy(part.content)">复制分项</button>
          <pre>{{ part.content }}</pre>
        </details>
      </div>
      <div v-else>
        <button class="cr-button" :disabled="!current.body" @click="copy(JSON.stringify(current.body, null, 2))">
          复制完整请求 JSON
        </button>
        <pre>{{ JSON.stringify(current.body, null, 2) }}</pre>
      </div>
    </template>
  </section>
</template>

<style scoped>
.cr-requests {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 14px 18px;
  display: grid;
  gap: 10px;
  align-content: start;
}
.cr-req-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.cr-req-bar label {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--cr-dim);
}
.cr-req-bar select,
.cr-req-search {
  background: var(--cr-panel-2);
  color: var(--cr-text);
  border: 1px solid var(--cr-line-2);
  border-radius: 6px;
  padding: 5px 7px;
  max-width: 100%;
}
.cr-req-search {
  flex: 1;
  min-width: 160px;
}
.cr-req-hint {
  margin: 0;
  color: var(--cr-dim);
  font-size: 12.5px;
  line-height: 1.7;
}
.cr-req-summary {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  background: var(--cr-panel-2);
  border: 1px solid var(--cr-line);
  border-radius: 8px;
}
.cr-req-summary small {
  color: var(--cr-faint);
}
.cr-button[aria-pressed='true'] {
  background: var(--cr-blue-soft);
  color: var(--cr-blue);
}
details {
  margin: 6px 0;
}
summary {
  cursor: pointer;
  color: var(--cr-dim);
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 360px;
  overflow: auto;
  font: 12.5px/1.6 var(--cr-mono);
  padding: 10px;
  background: var(--cr-panel-2);
  border-radius: 6px;
}
</style>
