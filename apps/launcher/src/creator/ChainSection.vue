<script setup lang="ts">
import { computed } from 'vue'
import { KIND_LABEL, truncate } from './format.ts'
import { useCreatorStore } from './store.ts'
import { causalChain, locationBefore, RELATION_META, transitions, type Relation } from './timeline.ts'
import type { TraceNode } from './types.ts'

/** 选中事件的“发起—裁定—状态变化—观察—后续”，只列有显式标识的关联。 */
const props = defineProps<{ node: TraceNode }>()
const store = useCreatorStore()

const current = computed(() => store.timelineTrace.find(item => item.key === props.node.key) ?? props.node)
const chain = computed(() => causalChain(current.value, store.timelineTrace, store.details, store.timelineCharacters))
const nameOf = (id: string, table: 'characters' | 'locations') => store.label(id, table)
const ownChanges = computed(() => transitions(current.value, store.timelineTrace, nameOf))
const place = computed(() => {
  const node = current.value
  if (!node.characterId || node.seq === undefined) return null
  if (node.event?.eventType === 'character.moved') return null
  const location = locationBefore(node.characterId, node.seq, store.timelineTrace)
  return location ? store.label(location, 'locations') : ''
})

const steps = computed(() => [
  { title: '发起', items: chain.value.origin, empty: '没有关联到的表达或处理记录。' },
  { title: '裁定', items: chain.value.verdict, empty: '没有关联到的裁定。' },
  { title: '状态变化', items: chain.value.changes, empty: '同一行动 / 同一提交中没有状态变更事件。' },
  { title: '观察投递', items: chain.value.observations, empty: '没有关联到的观察事件。' },
  { title: '后续响应', items: chain.value.followUps, empty: '同一处理周期内没有后续轮次。' },
])

function open(relation: Relation) {
  store.selectNode(relation.node)
}
function rowSub(relation: Relation) {
  const node = relation.node
  const where = node.seq === undefined ? '记录' : `#${node.seq}`
  if (node.key === current.value.key) return `${where} · 当前选中`
  const kind = RELATION_META[relation.kind].label
  return [where, relation.kind === 'cycle' && node.sortSeq < current.value.sortSeq ? `${kind}（较早轮次）` : kind].join(
    ' · ',
  )
}
</script>

<template>
  <section class="cr-chain">
    <div class="cr-kv">
      <dt>位置</dt>
      <dd v-if="place === null">—</dd>
      <dd v-else-if="place">{{ place }}<span class="cr-muted">（按已载入的移动事件推导）</span></dd>
      <dd v-else class="cr-muted">更早的移动记录未载入，无法确定</dd>
      <dt>确定关联</dt>
      <dd>{{ chain.relations.length }} 条</dd>
    </div>

    <div v-if="ownChanges.length" class="cr-chain-step">
      <h3>本事件的变更前 → 变更后</h3>
      <div class="cr-kv">
        <template v-for="change in ownChanges" :key="change.label">
          <dt>{{ change.label }}</dt>
          <dd>
            <span v-if="change.beforeKnown">{{ truncate(change.before || '（空）', 80) }}</span>
            <span v-else class="cr-muted">前值未载入</span>
            →
            {{ truncate(change.after || '（空）', 80) }}
          </dd>
        </template>
      </div>
    </div>

    <p v-if="chain.sharedCommit" class="cr-tag warn" style="height: auto; white-space: normal">
      该提交包含
      {{ chain.sharedCommit.actions }} 个行动；同一提交里的状态变更只能确定为一起写入，不能确定归属于哪个行动。
    </p>

    <div v-for="step in steps" :key="step.title" class="cr-chain-step">
      <h3>{{ step.title }}</h3>
      <button
        v-for="relation in step.items"
        :key="relation.node.key"
        class="cr-chain-row"
        :class="{ current: relation.node.key === current.key }"
        :title="`${RELATION_META[relation.kind].label}：${RELATION_META[relation.kind].evidence}`"
        @click="open(relation)"
      >
        <span class="cr-kind" :class="relation.node.tone">{{ KIND_LABEL[relation.node.kind] }}</span>
        <span class="cr-cell-main"
          >{{ store.label(relation.node.characterId) ? `${store.label(relation.node.characterId)}：` : ''
          }}{{ relation.node.summary }}</span
        >
        <small>{{ rowSub(relation) }}</small>
      </button>
      <p v-if="!step.items.length" class="cr-chain-empty">{{ step.empty }}</p>
      <template v-if="step.title === '观察投递'">
        <div v-if="chain.recipients.length" class="cr-chain-people" style="margin-top: 4px">
          <span
            v-for="recipient in chain.recipients"
            :key="recipient.observationSeq"
            class="cr-tag"
            :class="recipient.visibility === 'full' ? 'ok' : 'muted'"
          >
            {{ store.label(recipient.characterId) }} · {{ recipient.visibility === 'full' ? '完整内容' : '仅知发生' }}
          </span>
        </div>
        <p v-if="chain.unobserved?.length" class="cr-chain-empty" style="margin-top: 4px">
          未收到该行动观察记录：{{
            chain.unobserved.map(id => store.label(id)).join('、')
          }}。之后是否从别人口中得知，需看其后续观察。
        </p>
        <p v-else-if="chain.unobserved" class="cr-chain-empty" style="margin-top: 4px">
          全部已知角色都收到了观察记录。
        </p>
      </template>
    </div>

    <ul class="cr-chain-notes">
      <li v-for="note in chain.notes" :key="note">{{ note }}</li>
      <li>
        只列共享 actionId、eventRefs、decisionId、transactionId 或 participantId
        的条目；时间相邻不算关联，模型内部动机不作为事实。
      </li>
    </ul>
  </section>
</template>
