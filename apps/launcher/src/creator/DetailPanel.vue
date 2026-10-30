<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowLeft, Copy, ExternalLink, X } from '@lucide/vue'
import type { InspectedRequest } from '@harness-world/provider-chat'
import type { CreatorInspectionSnapshot } from '../../../../desktop/host/creator-inspection.ts'
import type { CreatorRecord } from '../../../../desktop/host/creator-records.ts'
import {
  activityStatus,
  asArray,
  asRecord,
  dateTimeLabel,
  durationLabel,
  inlineJson,
  KIND_LABEL,
  readable,
  timeLabel,
  tokenLabel,
  truncate,
} from './format.ts'
import ChainSection from './ChainSection.vue'
import { useCreatorStore } from './store.ts'
import type { TraceNode } from './types.ts'

type CharacterDetail = NonNullable<CreatorInspectionSnapshot['character']>

const store = useCreatorStore()
const tab = ref('')
const notice = ref('')

const selection = computed(() => store.selection)
const record = computed<CreatorRecord | null>(() => store.selectionDetail)
const node = computed<TraceNode | null>(() => store.selectionNode)
const request = computed<InspectedRequest | null>(() =>
  record.value?.kind === 'request' ? (record.value.data as InspectedRequest) : null,
)
const entity = computed(() =>
  selection.value?.kind === 'entity' ? (store.entities.find(item => item.id === selection.value!.id) ?? null) : null,
)
const character = computed<CharacterDetail | null>(() =>
  selection.value?.kind === 'character' ? store.characterDetail(selection.value.id) : null,
)

const PART_NAMES: Record<string, string> = {
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

function tabsFor(): string[] {
  const current = selection.value
  if (!current) return []
  if (current.kind === 'record') {
    switch (record.value?.kind ?? node.value?.kind) {
      case 'request':
      case 'model':
        return ['概览', '链路', '上下文', '预设', '响应', '思考', '计时', '原始 JSON']
      case 'action':
        return ['概览', '链路', '参数', '结果', 'Schema', '计时', '原始 JSON']
      case 'recall':
        return ['概览', '链路', '查询与返回', '原始 JSON']
      case 'decision':
        return ['概览', '链路', '提案', '原始 JSON']
      case 'turn':
        return ['概览', '链路', '数据', '原始 JSON']
      default:
        return ['概览', '原始 JSON']
    }
  }
  if (current.kind === 'event') return ['正文', '链路', '受众', '来源', '关联记录', '原始 JSON']
  if (current.kind === 'entity') return ['当前状态', '流转历史', '角色观察', '原始 JSON']
  if (current.kind === 'character') return ['概览', '授权观察', '最近请求', '记忆分层', '原始 JSON']
  if (current.kind === 'activity') return ['活动状态']
  if (current.kind === 'status') return ['状态值']
  return ['概览', '原始数据']
}

/** 关联记录：同一行动的行动记录给出的 decisionId 会把整组调用串起来。 */
const relatedRecords = computed(() => {
  const current = node.value
  const actionId = current?.actionId
  if (!actionId) return []
  const anchor = Object.values(store.details).find(
    item => item.kind === 'action' && asRecord(item.data).actionId === actionId,
  )
  if (!anchor?.decisionId) return []
  return store.records.filter(item => item.decisionId === anchor.decisionId)
})

const relatedEvents = computed(() => {
  const item = node.value?.history
  if (!item) return []
  const seqs = new Set([...item.relatedSeqs, item.event.seq])
  return store.trace.filter(node => node.seq !== undefined && seqs.has(node.seq))
})

/** 已知角色中没有收到这次行动观察记录的人；受众由服务端按完整前缀推导。 */
const unobserved = computed(() => {
  const item = node.value?.history
  if (!item?.actionId || !item.recipients.length) return []
  const seen = new Set(item.recipients.map(recipient => recipient.characterId))
  return store.timelineCharacters.map(character => character.id).filter(id => !seen.has(id))
})

const entityFlow = computed(() => (selection.value ? store.entityFlow(selection.value.id) : []))
const entityObservations = computed(() =>
  entityFlow.value.filter(item => item.event.eventType === 'observation.upsert'),
)
const entityChanges = computed(() =>
  entityFlow.value.filter(item => item.event.eventType.startsWith('entity.') || item.entityChange),
)

const toolSchema = computed(() => {
  const action = asRecord(asRecord(record.value?.data).action)
  const type = String(action.actionType ?? '')
  if (!type) return null
  for (const detail of Object.values(store.details)) {
    if (detail.kind !== 'request') continue
    const body = (detail.data as InspectedRequest).body
    const tools = asArray(asRecord(body).tools)
    for (const value of tools) {
      const fn = asRecord(asRecord(value).function)
      if (fn.name === type) return fn
    }
  }
  return null
})

const memorySections = computed(() => (character.value ? Object.entries(character.value.memory.sections) : []))

const activityIndex = computed<Record<string, Record<string, unknown>>>(() =>
  Object.fromEntries(store.activities.map(item => [String(asRecord(item).activityKey ?? ''), asRecord(item)])),
)

/** 状态路径形如 public.gateOpen 或 characters.<id>.energy。 */
const statusValue = computed(() => {
  const current = selection.value
  if (!current || current.kind !== 'status') return null
  const [scope, ...rest] = current.id.split('.')
  const statusTruth = store.world?.statusTruth
  if (!statusTruth) return null
  if (scope === 'public') return rest.reduce<unknown>((value, key) => asRecord(value)[key], statusTruth.public)
  if (scope === 'characters') {
    const [characterId, ...keys] = rest
    return keys.reduce<unknown>(
      (value, key) => asRecord(value)[key],
      asRecord(statusTruth.characters)[characterId ?? ''],
    )
  }
  return null
})

async function copy(value: unknown) {
  try {
    await navigator.clipboard.writeText(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    notice.value = '已复制。'
  } catch {
    notice.value = '复制未完成，可在正文中选中文本复制。'
  }
}

function jump(key: string) {
  if (key) store.focus(key)
}

watch(
  () => selection.value?.id,
  async () => {
    const next = tabsFor()
    tab.value = next[0] ?? ''
    notice.value = ''
    const current = selection.value
    if (!current) return
    if (current.kind === 'record') await store.ensureDetail(current.id).catch(() => undefined)
    if (current.kind === 'entity') await store.loadEntityHistory(current.id).catch(() => undefined)
    if (current.kind === 'character') await store.loadCharacterDetail(current.id).catch(() => undefined)
    tab.value = tabsFor()[0] ?? ''
  },
  { immediate: true },
)

function toneOf(value: boolean): string {
  return value ? 'ok' : 'danger'
}
</script>

<template>
  <aside class="cr-detail" :style="{ width: `${store.detailWidth}px` }" aria-label="选中内容详情">
    <div class="cr-detail-head">
      <button v-if="store.canGoBack" class="cr-icon-button" aria-label="返回上一条" @click="store.back()">
        <ArrowLeft :size="15" />
      </button>
      <strong>{{ selection?.label ?? '未选中内容' }}</strong>
      <span class="cr-spacer" />
      <button class="cr-icon-button" aria-label="关闭详情" @click="store.closeDetail()"><X :size="15" /></button>
    </div>

    <div v-if="selection" class="cr-detail-tabs">
      <button
        v-for="name in tabsFor()"
        :key="name"
        class="cr-tab"
        :class="{ active: tab === name }"
        @click="tab = name"
      >
        {{ name }}
      </button>
    </div>

    <div v-if="node && (selection?.kind === 'event' || selection?.kind === 'record')" class="cr-detail-links">
      <button v-if="store.view !== 'trace'" class="cr-button tiny" @click="store.reveal('trace', node.key)">
        在轨迹页查看
      </button>
      <button v-if="store.view !== 'timeline'" class="cr-button tiny" @click="store.reveal('timeline', node.key)">
        在时间线查看
      </button>
    </div>

    <div class="cr-detail-body">
      <p v-if="notice" class="cr-tag ok" style="height: auto">{{ notice }}</p>
      <p v-if="!selection" class="cr-muted">在中间列表或对话中点击条目，这里显示可读信息；原始数据在最后一级。</p>

      <!-- 事件与记录共用：有证据的上下游链路 -->
      <ChainSection v-else-if="tab === '链路' && node" :node="node" />

      <!-- 私有记录：模型调用 -->
      <template v-else-if="selection.kind === 'record' && (record?.kind === 'request' || node?.kind === 'model')">
        <template v-if="!record"><p class="cr-muted">正在读取记录正文…</p></template>
        <template v-else-if="request">
          <section v-if="tab === '概览'" class="cr-kv">
            <dt>角色</dt>
            <dd>{{ store.label(request.characterId) }}</dd>
            <dt>记录来源</dt>
            <dd>{{ request.continuation ? '继续处理' : '新刺激' }} · 决策 {{ request.decisionId ?? '—' }}</dd>
            <dt>模型</dt>
            <dd class="cr-mono">{{ request.model }}</dd>
            <dt>状态</dt>
            <dd>
              <span class="cr-tag" :class="node?.tone">{{ node?.statusLabel ?? request.status }}</span>
            </dd>
            <dt>开始时间</dt>
            <dd>{{ dateTimeLabel(request.startedAt) }}</dd>
            <dt>用量</dt>
            <dd>
              输入 {{ tokenLabel(request.usage?.inputTokens) }} / 输出 {{ tokenLabel(request.usage?.outputTokens) }} /
              合计 {{ tokenLabel(request.usage?.totalTokens) }}
            </dd>
            <dt>本地估算</dt>
            <dd>请求 JSON 约 {{ request.estimatedBodyTokens }} token（其中工具 {{ request.estimatedToolTokens }}）</dd>
            <dt>视图序号</dt>
            <dd>{{ request.asOfWorldSeq ?? '—' }}</dd>
            <p v-if="request.omitted" class="cr-tag warn" style="height: auto">{{ request.omitted }}</p>
            <p class="cr-muted" style="grid-column: 1 / -1">
              本地估算不等于模型 tokenizer 计数；传输成功不代表决策通过裁定。
            </p>
          </section>

          <section v-else-if="tab === '上下文'">
            <div v-for="part in request.contextParts" :key="part.name" class="cr-block">
              <header>
                <strong>{{ PART_NAMES[part.name] ?? part.name }}</strong
                ><span class="cr-mono">{{ part.name }}</span
                ><span class="cr-spacer" style="margin-left: auto" /><span>约 {{ part.estimatedTokens }} token</span>
              </header>
              <div>
                <pre>{{ part.content }}</pre>
              </div>
            </div>
            <p v-if="!request.contextParts.length" class="cr-muted">本次没有上下文分项。</p>
          </section>

          <section v-else-if="tab === '预设'">
            <div class="cr-kv">
              <dt>来源</dt>
              <dd>
                {{
                  request.preset?.origin.scope === 'character'
                    ? '角色专属'
                    : request.preset?.origin.scope === 'group'
                      ? '角色组'
                      : '默认'
                }}
                · {{ request.preset?.origin.name ?? '未记录' }}
              </dd>
              <dt>基础预设</dt>
              <dd>
                {{ request.preset?.origin.base?.mode ?? '—' }}（{{ request.preset?.origin.base?.layers.length ?? 0 }}
                层）
              </dd>
              <dt>采样</dt>
              <dd class="cr-mono">
                temperature {{ request.preset?.value.temperature ?? '—' }} · topP
                {{ request.preset?.value.topP ?? '—' }} · max {{ request.preset?.value.maxOutputTokens ?? '—' }}
              </dd>
            </div>
            <div v-for="item in request.preset?.value.nodes ?? []" :key="item.id" class="cr-block">
              <header>
                <strong>{{ item.name }}</strong
                ><span>{{ item.role }}</span
                ><span>{{ item.position === 'beforeContext' ? '上下文之前' : '上下文之后' }}</span
                ><span>{{ item.enabled ? '启用' : '已禁用，未发送' }}</span>
              </header>
              <div>
                <pre>{{ item.content }}</pre>
              </div>
            </div>
            <details v-if="request.preset?.value.prompt" class="cr-block">
              <summary style="padding: 6px 10px; cursor: pointer">原始 prompt 文本</summary>
              <div>
                <pre>{{ request.preset.value.prompt }}</pre>
              </div>
            </details>
            <p class="cr-muted">禁用节点仍保存在预设快照中，但不会伪装成已发送消息。</p>
          </section>

          <section v-else-if="tab === '响应'">
            <div class="cr-kv">
              <dt>结束原因</dt>
              <dd class="cr-mono">{{ request.response?.finishReason ?? '—' }}</dd>
              <dt>工具调用</dt>
              <dd>{{ request.response?.toolCalls.length ?? 0 }} 次</dd>
            </div>
            <div v-for="(text, index) in request.response?.content ?? []" :key="index" class="cr-block">
              <header>
                <strong>模型正文 {{ index + 1 }}</strong>
              </header>
              <div>
                <pre>{{ text }}</pre>
              </div>
            </div>
            <div v-for="(call, index) in request.response?.toolCalls ?? []" :key="`t${index}`" class="cr-block">
              <header>
                <strong>工具 {{ call.name }}</strong
                ><span class="cr-mono">{{ call.id ?? '无 id' }}</span>
              </header>
              <div>
                <pre>{{ JSON.stringify(call.arguments, null, 2) }}</pre>
              </div>
            </div>
            <p v-if="!(request.response?.content.length || request.response?.toolCalls.length)" class="cr-muted">
              没有保留的模型正文或工具调用。
            </p>
          </section>

          <section v-else-if="tab === '思考'">
            <p class="cr-muted">
              状态：{{
                request.response?.thinkingStatus === 'provided' ? '服务已返回' : '服务未返回'
              }}。不还原未返回内容，不捕获隐藏思考。
            </p>
            <div v-for="(item, index) in request.response?.thinking ?? []" :key="index" class="cr-block">
              <header>
                <strong>{{ item.kind === 'summary' ? '思考摘要' : '思考正文' }}</strong
                ><span>{{ item.kind === 'summary' ? '服务标记为摘要' : '服务提供的正文' }}</span>
              </header>
              <div>
                <pre>{{ item.text }}</pre>
              </div>
            </div>
          </section>

          <section v-else-if="tab === '计时'">
            <div class="cr-kv">
              <dt>耗时</dt>
              <dd>{{ durationLabel(request.durationMs) || '未记录' }}</dd>
              <dt>开始</dt>
              <dd>{{ dateTimeLabel(request.startedAt) }}</dd>
              <dt>HTTP</dt>
              <dd class="cr-mono">{{ request.httpStatus ?? '—' }}</dd>
              <dt>失败原因</dt>
              <dd>{{ request.failure ?? '无' }}</dd>
            </div>
          </section>

          <section v-else>
            <button class="cr-button tiny" @click="copy(request.body ?? record)">复制完整请求 JSON</button>
            <pre class="cr-pre">{{ JSON.stringify(request.body ?? record.data, null, 2) }}</pre>
            <details class="cr-block" style="margin-top: 8px">
              <summary style="padding: 6px 10px; cursor: pointer">
                消息顺序（{{ request.messages.length }} 条，带来源）
              </summary>
              <div>
                <div v-for="(message, index) in request.messages" :key="index" style="margin-bottom: 8px">
                  <div class="cr-mono">
                    {{ index + 1 }}. {{ message.source.name }} · {{ message.role }} · 约
                    {{ message.estimatedTokens }} token
                  </div>
                  <pre>{{ message.content }}</pre>
                </div>
              </div>
            </details>
          </section>
        </template>
      </template>

      <!-- 私有记录：行动 -->
      <template v-else-if="selection.kind === 'record' && (record?.kind === 'action' || node?.kind === 'action')">
        <template v-if="!record"><p class="cr-muted">正在读取记录正文…</p></template>
        <template v-else>
          <section v-if="tab === '概览'" class="cr-kv">
            <dt>行动</dt>
            <dd>{{ node?.summary ?? '—' }}</dd>
            <dt>角色</dt>
            <dd>{{ store.label(record.characterId) }}</dd>
            <dt>行动 ID</dt>
            <dd class="cr-mono">{{ asRecord(record.data).actionId ?? '—' }}</dd>
            <dt>结果</dt>
            <dd>
              <span class="cr-tag" :class="node?.tone">{{ node?.statusLabel }}</span>
            </dd>
            <dt>裁定说明</dt>
            <dd>{{ asRecord(record.data).reason ?? '无' }}</dd>
            <dt>关联事件</dt>
            <dd>
              <button
                v-for="seq in asArray(asRecord(record.data).eventRefs)"
                :key="String(seq)"
                class="cr-button tiny"
                style="margin-right: 4px"
                @click="jump(`e${seq}`)"
              >
                #{{ seq }}
              </button>
            </dd>
          </section>

          <section v-else-if="tab === '参数'">
            <pre class="cr-pre">{{
              JSON.stringify(asRecord(asRecord(record.data).action).parameters ?? {}, null, 2)
            }}</pre>
          </section>

          <section v-else-if="tab === '结果'">
            <pre class="cr-pre">{{
              JSON.stringify(
                {
                  status: asRecord(record.data).status,
                  reason: asRecord(record.data).reason,
                  eventRefs: asRecord(record.data).eventRefs,
                },
                null,
                2,
              )
            }}</pre>
            <p class="cr-muted">被拒绝的行动有参数与结果，但不生成物品状态变更。</p>
          </section>

          <section v-else-if="tab === 'Schema'">
            <p v-if="!toolSchema" class="cr-muted">
              本次运行保留的请求里没有同名工具定义；Schema 来自实际发送的请求正文。
            </p>
            <pre v-else class="cr-pre">{{ JSON.stringify(toolSchema, null, 2) }}</pre>
          </section>

          <section v-else-if="tab === '计时'">
            <div class="cr-kv">
              <dt>裁定与提交</dt>
              <dd>{{ durationLabel(Number(asRecord(record.data).durationMs)) || '未记录' }}</dd>
              <dt>开始</dt>
              <dd>{{ dateTimeLabel(String(asRecord(record.data).startedAt ?? '')) }}</dd>
              <dt>提交前序号</dt>
              <dd class="cr-mono">
                {{ asRecord(record.data).afterSeq ?? '—' }} → {{ asRecord(record.data).headSeq ?? '—' }}
              </dd>
            </div>
          </section>

          <section v-else>
            <button class="cr-button tiny" @click="copy(record.data)">复制原始 JSON</button>
            <pre class="cr-pre">{{ JSON.stringify(record.data, null, 2) }}</pre>
          </section>
        </template>
      </template>

      <!-- 私有记录：决策 / 轮次 / 召回 -->
      <template v-else-if="selection.kind === 'record'">
        <template v-if="!record"><p class="cr-muted">正在读取记录正文…</p></template>
        <template v-else-if="tab === '概览' || tab === '数据'">
          <div class="cr-kv">
            <dt>类型</dt>
            <dd>{{ record.kind }} · {{ record.summary.label }}</dd>
            <dt>角色</dt>
            <dd>{{ store.label(record.characterId) }}</dd>
            <dt>决策</dt>
            <dd class="cr-mono">{{ record.decisionId ?? '—' }}</dd>
            <dt>采集时间</dt>
            <dd>{{ dateTimeLabel(record.capturedAt) }}</dd>
            <dt>状态</dt>
            <dd>
              {{ record.summary.status ?? '—'
              }}{{ record.summary.durationMs === undefined ? '' : ` · ${durationLabel(record.summary.durationMs)}` }}
            </dd>
          </div>
          <pre class="cr-pre">{{ JSON.stringify(record.data, null, 2) }}</pre>
        </template>
        <template v-else-if="tab === '查询与返回'">
          <div class="cr-kv">
            <dt>查询</dt>
            <dd>{{ readable(asRecord(record.data).query) }}</dd>
            <dt>视图序号</dt>
            <dd>{{ asRecord(record.data).asOfWorldSeq ?? '—' }}</dd>
          </div>
          <div v-for="(memory, index) in asArray(asRecord(record.data).memories)" :key="index" class="cr-block">
            <header>
              <strong>记忆 {{ index + 1 }}</strong>
            </header>
            <div>
              <pre>{{ readable(memory) }}</pre>
            </div>
          </div>
          <p class="cr-muted">
            {{ asRecord(record.data).note ?? '召回是本次发送内容的证据；长期档案里有某条记忆，不证明它这次被发送。' }}
          </p>
        </template>
        <template v-else-if="tab === '提案'">
          <pre class="cr-pre">{{ JSON.stringify(asRecord(record.data).value ?? record.data, null, 2) }}</pre>
          <p class="cr-muted">决策是预设输出处理后的提案，source 区分 model / script；不能当作已提交事实。</p>
        </template>
        <template v-else>
          <button class="cr-button tiny" @click="copy(record.data)">复制原始 JSON</button>
          <pre class="cr-pre">{{ JSON.stringify(record.data, null, 2) }}</pre>
        </template>
      </template>

      <!-- 已提交事件 -->
      <template v-else-if="selection.kind === 'event'">
        <section v-if="tab === '正文'">
          <div class="cr-kv">
            <dt>事件类型</dt>
            <dd class="cr-mono">{{ node?.event?.eventType }}</dd>
            <dt>序号 / tick</dt>
            <dd>#{{ node?.seq }} · tick {{ node?.tick }}</dd>
            <dt>行为者</dt>
            <dd>{{ store.label(node?.characterId) || '—' }}</dd>
            <dt>事务</dt>
            <dd class="cr-mono">
              {{ String(asRecord(node?.event?.data).roundId ?? node?.event?.transactionId ?? '—') }}
            </dd>
          </div>
          <div class="cr-block">
            <header><strong>正文</strong></header>
            <div>
              <pre>{{
                readable(
                  asRecord(node?.event?.data).text ??
                    asRecord(asRecord(node?.event?.data).value).content ??
                    node?.event?.data,
                )
              }}</pre>
            </div>
          </div>
          <div v-if="node?.event?.eventType === 'action.resolved'" class="cr-block">
            <header><strong>行动裁定</strong></header>
            <div>
              <pre>{{ JSON.stringify(node.history?.action ?? {}, null, 2) }}</pre>
            </div>
          </div>
        </section>

        <section v-else-if="tab === '受众'">
          <p class="cr-muted">受众来自实际 observation.upsert；对白的 addresseeIds 是交谈对象，不是全部听众。</p>
          <div
            v-for="recipient in node?.history?.recipients ?? []"
            :key="recipient.characterId"
            class="cr-list-row"
            style="grid-template-columns: minmax(0, 1fr) 120px 90px"
          >
            <span class="cr-strong">{{ store.label(recipient.characterId) }}</span>
            <span
              ><span class="cr-tag" :class="recipient.visibility === 'full' ? 'ok' : 'muted'">{{
                recipient.visibility === 'full' ? '完整内容' : '仅知发生'
              }}</span></span
            >
            <button class="cr-button tiny" @click="jump(`e${recipient.observationSeq}`)">
              观察 #{{ recipient.observationSeq }}
            </button>
          </div>
          <p v-if="!node?.history?.recipients.length" class="cr-muted">没有记录到受众。空数组不证明无人知情。</p>
          <p v-else-if="unobserved.length" class="cr-muted">
            未收到该行动观察记录：{{
              unobserved.map(id => store.label(id)).join('、')
            }}（不按同场景或时间推定他们知道）。
          </p>
        </section>

        <section v-else-if="tab === '来源'">
          <div class="cr-kv">
            <dt>事务 ID</dt>
            <dd class="cr-mono">{{ node?.event?.transactionId }}</dd>
            <dt>事件版本</dt>
            <dd class="cr-mono">{{ node?.event?.eventVersion }}</dd>
            <dt>前序哈希</dt>
            <dd class="cr-mono">{{ truncate(String(node?.event?.previousHash ?? ''), 40) }}</dd>
            <dt>事件哈希</dt>
            <dd class="cr-mono">{{ truncate(String(node?.event?.eventHash ?? ''), 40) }}</dd>
            <dt>物品变更</dt>
            <dd v-if="node?.history?.entityChange">
              {{ node.history.entityChange.followsHolder ? '随保管者移动' : '保管／地点变更' }}
            </dd>
            <dd v-else>无</dd>
          </div>
        </section>

        <section v-else-if="tab === '关联记录'">
          <p class="cr-muted">同一行动关联的模型调用、决策与轮次；需要事先开启采集。</p>
          <div
            v-for="item in relatedRecords"
            :key="item.id"
            class="cr-list-row"
            style="grid-template-columns: 76px minmax(0, 1fr) 90px"
          >
            <span class="cr-kind" :class="item.kind === 'request' ? 'accent' : item.kind === 'turn' ? 'muted' : 'ok'">{{
              item.kind
            }}</span>
            <span class="cr-muted"
              >{{ timeLabel(item.capturedAt) }} · {{ item.summary.status ?? '—'
              }}{{ item.summary.durationMs === undefined ? '' : ` · ${durationLabel(item.summary.durationMs)}` }}</span
            >
            <button
              class="cr-button tiny"
              @click="store.select({ kind: 'record', id: item.id, label: `记录 · ${store.label(item.characterId)}` })"
            >
              查看
            </button>
          </div>
          <p v-if="!relatedRecords.length" class="cr-muted">
            没有可关联的私有记录（未开启采集，或该行动早于采集开始）。
          </p>
          <h2 style="margin-top: 12px">关联事件</h2>
          <div
            v-for="item in relatedEvents"
            :key="item.key"
            class="cr-list-row"
            style="grid-template-columns: 60px minmax(0, 1fr) 70px"
          >
            <span class="cr-kind" :class="item.tone">{{ KIND_LABEL[item.kind] }}</span>
            <span class="cr-muted">{{ truncate(item.summary, 60) }}</span>
            <button class="cr-button tiny" @click="jump(item.key)">跳转</button>
          </div>
          <p v-if="!relatedEvents.length" class="cr-muted">没有其他关联事件。</p>
        </section>

        <section v-else>
          <button class="cr-button tiny" @click="copy(node?.event)">复制事件 JSON</button>
          <pre class="cr-pre">{{ JSON.stringify(node?.event ?? {}, null, 2) }}</pre>
        </section>
      </template>

      <!-- 物品 -->
      <template v-else-if="selection.kind === 'entity'">
        <section v-if="tab === '当前状态'">
          <div class="cr-kv">
            <dt>物品</dt>
            <dd>{{ entity?.name ?? selection.id }}</dd>
            <dt>保管者</dt>
            <dd>{{ store.label(asRecord(entity?.state).holderId as string) || '无人保管' }}</dd>
            <dt>有效地点</dt>
            <dd>
              {{ store.label(entity?.effectiveLocationId, 'locations') || '未知' }}（依据：{{
                entity?.locationBasis === 'holder'
                  ? '来自保管者位置'
                  : entity?.locationBasis === 'entity'
                    ? '物品自身地点'
                    : '未知'
              }}）
            </dd>
            <dt>最近变更</dt>
            <dd>#{{ entity?.lastChangeSeq ?? '—' }}</dd>
          </div>
          <p class="cr-muted">holderId 表示保管或携带，未单独追踪法律所有权；不能据此宣称精确姿态或桌面位置。</p>
          <pre class="cr-pre">{{ JSON.stringify(entity?.state ?? {}, null, 2) }}</pre>
        </section>

        <section v-else-if="tab === '流转历史'" class="cr-timeline">
          <div
            v-for="item in entityChanges"
            :key="item.event.seq"
            class="cr-timeline-item"
            :class="item.entityChange?.followsHolder ? 'warn' : 'ok'"
          >
            <div class="cr-tl-main">#{{ item.event.seq }} · {{ item.event.eventType }}</div>
            <div class="cr-tl-sub">
              {{ store.label(asRecord(item.entityChange?.before).holderId as string) || '无人保管' }} →
              {{ store.label(asRecord(item.entityChange?.after).holderId as string) || '无人保管' }}
              <span v-if="item.entityChange?.followsHolder"> · 随保管者移动，不是独立转移</span>
            </div>
            <button class="cr-button tiny" @click="store.reveal('trace', `e${item.event.seq}`)">在轨迹中查看</button>
            <button class="cr-button tiny" @click="store.reveal('timeline', `e${item.event.seq}`)">在时间线查看</button>
          </div>
          <p v-if="!entityChanges.length" class="cr-muted">
            没有结构化追踪的流转记录。查询只按结构化实体目标建立关联，不从对白关键词推测物品已转移。
          </p>
        </section>

        <section v-else-if="tab === '角色观察'">
          <div v-for="item in entityObservations" :key="item.event.seq" class="cr-block">
            <header>
              <strong>{{ store.label(String(asRecord(asRecord(item.event.data).value).observerId)) }}</strong
              ><span>#{{ item.event.seq }}</span>
            </header>
            <div>
              <pre>{{ readable(asRecord(asRecord(item.event.data).value).content) }}</pre>
            </div>
          </div>
          <p v-if="!entityObservations.length" class="cr-muted">没有记录到与这个物品相关的观察。</p>
        </section>

        <section v-else>
          <pre class="cr-pre">{{
            JSON.stringify(
              {
                state: entity?.state ?? {},
                holderMeaning: entity?.holderMeaning,
                locationBasis: entity?.locationBasis,
              },
              null,
              2,
            )
          }}</pre>
        </section>
      </template>

      <!-- 角色 -->
      <template v-else-if="selection.kind === 'character'">
        <template v-if="!character"><p class="cr-muted">正在读取角色档案…</p></template>
        <template v-else>
          <section v-if="tab === '概览'" class="cr-kv">
            <dt>角色</dt>
            <dd>{{ store.label(character.id) }}</dd>
            <dt>认知前缀</dt>
            <dd class="cr-mono">asOfWorldSeq {{ character.currentView.asOfWorldSeq }}</dd>
            <dt>位置</dt>
            <dd>{{ store.label(character.currentView.locationId, 'locations') || '未知' }}</dd>
            <dt>生命周期</dt>
            <dd>{{ character.currentView.lifecycleState }}</dd>
            <dt>场景</dt>
            <dd>{{ character.currentView.scenes.map(scene => scene.sceneId).join('、') || '无' }}</dd>
            <dt>整理边界</dt>
            <dd>{{ character.memory.archivePrefix ?? '—' }}</dd>
            <dt>维护</dt>
            <dd>{{ character.memory.maintenance ? inlineJson(character.memory.maintenance, 80) : '无' }}</dd>
            <dt>时间线</dt>
            <dd>
              <button class="cr-button tiny" @click="store.timelineForCharacter(character.id)">
                只看此角色的时间线
              </button>
            </dd>
          </section>

          <section v-else-if="tab === '授权观察'">
            <p class="cr-muted">{{ character.contextNotice }}</p>
            <div v-for="(observation, index) in character.currentView.observations" :key="index" class="cr-block">
              <header>
                <strong>观察 {{ index + 1 }}</strong>
              </header>
              <div>
                <pre>{{ readable(asRecord(observation).value ?? observation) }}</pre>
              </div>
            </div>
            <h2 style="margin-top: 10px">目标与认识</h2>
            <div v-for="(goal, index) in character.currentView.goals" :key="`g${index}`" class="cr-block">
              <header>
                <strong>目标 {{ index + 1 }}</strong>
              </header>
              <div>
                <pre>{{ readable(asRecord(goal).value ?? goal) }}</pre>
              </div>
            </div>
            <div v-for="(claim, index) in character.currentView.claims" :key="`c${index}`" class="cr-block">
              <header>
                <strong>认识 {{ index + 1 }}</strong>
              </header>
              <div>
                <pre>{{ readable(asRecord(claim).value ?? claim) }}</pre>
              </div>
            </div>
            <p
              v-if="
                !(
                  character.currentView.observations.length ||
                  character.currentView.goals.length ||
                  character.currentView.claims.length
                )
              "
              class="cr-muted"
            >
              当前视图没有可显示的授权内容。
            </p>
          </section>

          <section v-else-if="tab === '最近请求'">
            <template v-if="character.latestRequest">
              <div class="cr-kv">
                <dt>模型</dt>
                <dd class="cr-mono">{{ character.latestRequest.model }}</dd>
                <dt>状态</dt>
                <dd>
                  {{ character.latestRequest.status }} ·
                  {{ durationLabel(character.latestRequest.durationMs) || '未记录' }}
                </dd>
                <dt>开始</dt>
                <dd>{{ dateTimeLabel(character.latestRequest.startedAt) }}</dd>
                <dt>视图序号</dt>
                <dd>{{ character.latestRequest.asOfWorldSeq ?? '—' }}</dd>
              </div>
              <button
                class="cr-button tiny"
                @click="
                  store.select({
                    kind: 'record',
                    id: character.latestRequest.recordId,
                    label: `模型调用 · ${store.label(character.id)}`,
                  })
                "
              >
                <ExternalLink :size="12" />打开完整记录
              </button>
            </template>
            <p v-else class="cr-muted">没有采集记录，或已被容量淘汰。需要先开启采集。</p>
          </section>

          <section v-else-if="tab === '记忆分层'">
            <p class="cr-muted">{{ character.memory.notice }}</p>
            <div v-for="[name, section] in memorySections" :key="name" class="cr-block">
              <header>
                <strong>{{ name }}</strong
                ><span>共 {{ section.total }} 条</span><span v-if="section.hasMore">还有更多</span>
              </header>
              <div>
                <pre v-for="(item, index) in section.items" :key="index">{{ readable(item) }}</pre>
                <p v-if="!section.items.length" class="cr-muted">本页没有条目。</p>
              </div>
            </div>
            <p class="cr-muted">长期档案有某条记忆，并不证明它在上一次调用中被发送给模型。</p>
          </section>

          <section v-else>
            <pre class="cr-pre">{{ JSON.stringify(character, null, 2) }}</pre>
          </section>
        </template>
      </template>

      <!-- 世界 / 状态 / 活动 -->
      <template v-else>
        <section v-if="selection.kind === 'status'">
          <div class="cr-kv">
            <dt>状态路径</dt>
            <dd class="cr-mono">{{ selection.id }}</dd>
            <dt>当前值</dt>
            <dd class="cr-mono">{{ inlineJson(statusValue, 400) }}</dd>
          </div>
          <pre class="cr-pre">{{ JSON.stringify(statusValue, null, 2) }}</pre>
          <p class="cr-muted">
            公开状态与角色私有状态分别在 概览 与 原始数据 中查看；读取不运行作者脚本，不重建历史值。
          </p>
        </section>
        <section v-else-if="selection.kind === 'activity'">
          <h2>概览</h2>
          <div class="cr-kv">
            <dt>活动</dt>
            <dd>{{ selection.label }}</dd>
            <dt>状态</dt>
            <dd>
              {{ activityStatus(asRecord(activityIndex[selection.id]).state)[0] }}
            </dd>
          </div>
          <pre class="cr-pre">{{ JSON.stringify(activityIndex[selection.id] ?? {}, null, 2) }}</pre>
          <p class="cr-muted">
            这些信息仅限创作者宿主；public 只在参与者间共享，private 仅给对应角色，internal 不进入角色视图。
          </p>
        </section>
        <section v-else-if="tab === '概览'">
          <div class="cr-kv">
            <dt>世界</dt>
            <dd>{{ store.world?.title }}</dd>
            <dt>地址</dt>
            <dd class="cr-mono">
              {{
                store.world
                  ? `${store.world.address.tenantId}/${store.world.address.worldId}/${store.world.address.branchId}`
                  : '—'
              }}
            </dd>
            <dt>版本</dt>
            <dd class="cr-mono">{{ store.world?.worldVersion }}</dd>
            <dt>已提交前缀</dt>
            <dd>序号 {{ store.world?.headSeq }} · tick {{ store.world?.tick }}</dd>
            <dt>故事线起点</dt>
            <dd>{{ store.world?.storyParentNodeId ?? '无父节点' }}</dd>
            <dt>采集时间</dt>
            <dd>{{ dateTimeLabel(store.world?.capturedAt) }}</dd>
          </div>
          <ul class="cr-muted" style="padding-left: 18px">
            <li v-for="item in store.limitations" :key="item">{{ item }}</li>
          </ul>
        </section>
        <section v-else>
          <button class="cr-button tiny" @click="copy(store.world?.statusTruth ?? {})">复制状态 JSON</button>
          <pre class="cr-pre">{{ JSON.stringify(store.world?.statusTruth ?? {}, null, 2) }}</pre>
        </section>
      </template>
    </div>
  </aside>
</template>
