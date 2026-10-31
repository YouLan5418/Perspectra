<script setup lang="ts">
import { computed } from 'vue'
import type { AutoStartEvaluation } from '../../../../desktop/host/pack-activities.ts'
import type { LensItem } from '../../../../desktop/lens/view.ts'
import { conditionItems } from '../../../../desktop/lens/ids.ts'
import { useLensStore } from './store.ts'
import { fieldValue, showValue } from './format.ts'
import ChangeBadge from './ChangeBadge.vue'

/** 按事件看：什么条件下触发（✔/✘ 按推演当前时刻，没有推演时是开场）、玩家能选什么、推演里选过之后改了什么。 */
const store = useLensStore()
const events = computed(() => store.inSection('events').filter(item => item.parentId === undefined))
const removed = computed(() => store.removedIn('events').filter(change => !change.id.includes('/')))
const conditions = computed(
  () => new Map((store.snapshot?.simulation.conditions ?? []).map(evaluation => [evaluation.activityKey, evaluation])),
)
const keyOf = (item: LensItem) => item.id.slice('event:'.length)

/** 条件条目的 id 规则与透视结果共用 desktop/lens/ids.ts，两边不会对不上。 */
function checkRows(item: LensItem, evaluation: AutoStartEvaluation) {
  const checks = evaluation.checks ?? []
  return conditionItems(item.id, checks).map((row, position) => ({ ...checks[position]!, ...row }))
}
const removedChecks = (item: LensItem) =>
  store.removedIn('events').filter(change => change.id.startsWith(item.id + '/when/'))

const STATE_LINES = new Set(['status', 'round-hook', 'item', 'moved', 'activity', 'rejected'])
/** 推演里和这个活动有关的步：玩家实际选过的操作，以及这一步带来的状态变化。 */
function chosen(item: LensItem) {
  const key = keyOf(item)
  return (store.snapshot?.simulation.trace ?? [])
    .filter(
      step =>
        (step.step.kind === 'activity' && step.step.request.activityKey === key) ||
        step.lines.some(line => line.kind === 'activity' && line.activityKey === key),
    )
    .map(step => ({
      index: step.index,
      input: step.lines.find(line => line.kind === 'input')?.text ?? '',
      lines: step.lines.filter(line => STATE_LINES.has(line.kind)),
      error: step.error,
    }))
}
</script>

<template>
  <section class="cr-center">
    <div class="cr-scroll">
      <p class="cr-banner">
        条件真假按{{
          store.snapshot?.simulation.trace.length ? '推演当前时刻' : '开场状态'
        }}计算；选项效果只在推演中实际选过之后显示。
      </p>
      <article
        v-for="item in events"
        :key="item.id"
        class="cr-section lens-event"
        :class="{ selected: store.selectedId === item.id }"
      >
        <h2 class="lens-event-title">
          <button class="lens-title-button" @click="store.select(item.id)">{{ item.title }}</button>
          <ChangeBadge :change="store.changesById.get(item.id)" :child="store.hasChildChange(item.id)" />
        </h2>
        <p class="lens-opening">{{ showValue(fieldValue(item.fields, 'opening') ?? '') }}</p>
        <p class="cr-muted lens-line">参与者：{{ showValue(fieldValue(item.fields, 'participants') ?? []) }}</p>

        <template v-if="conditions.get(keyOf(item))">
          <p class="lens-line">
            自动触发：
            <span v-if="conditions.get(keyOf(item))!.started" class="cr-tag ok">此刻会触发</span>
            <span v-else class="cr-tag muted">此刻不会触发</span>
            <span v-if="conditions.get(keyOf(item))!.error" class="cr-tag danger">
              {{ conditions.get(keyOf(item))!.error }}
            </span>
          </p>
          <ul class="lens-checks">
            <li
              v-for="check in checkRows(item, conditions.get(keyOf(item))!)"
              :key="check.id"
              :class="{ selected: store.selectedId === check.id }"
              @click="store.select(check.id)"
            >
              <span :class="check.met ? 'lens-met' : 'lens-unmet'">{{ check.met ? '✔' : '✘' }}</span>
              <span>{{ check.title }}</span>
              <span v-if="check.label === null" class="cr-mono cr-muted">{{ item.source.file }} · autoStart</span>
              <ChangeBadge :change="store.changesById.get(check.id)" />
            </li>
            <li v-for="change in removedChecks(item)" :key="change.id" class="lens-removed">
              <span>—</span><span>{{ change.title }}</span
              ><ChangeBadge :change="change" />
            </li>
          </ul>
          <p v-if="conditions.get(keyOf(item))!.checks === null" class="cr-muted lens-line">没有返回条件列表。</p>
        </template>

        <p class="lens-line">玩家操作：</p>
        <ul class="lens-ops">
          <li
            v-for="operation in (fieldValue(item.fields, 'operations') as string[] | undefined) ?? []"
            :key="operation"
          >
            {{ operation }}
          </li>
        </ul>
        <div v-for="step in chosen(item)" :key="step.index" class="cr-block lens-chosen">
          <header>
            <strong>推演第 {{ step.index + 1 }} 步</strong><span>{{ step.input }}</span>
          </header>
          <div>
            <p v-if="step.error" class="lens-unmet">{{ step.error }}</p>
            <p v-for="line in step.lines" :key="line.seq + line.text">{{ line.text }}</p>
            <p v-if="!step.lines.length && !step.error" class="cr-muted">这一步没有状态变化。</p>
          </div>
        </div>
      </article>
      <article v-for="change in removed" :key="change.id" class="cr-section lens-event lens-removed">
        <h2 class="lens-event-title">{{ change.title }} <ChangeBadge :change="change" /></h2>
      </article>
      <p v-if="!events.length && !removed.length" class="cr-empty">这个包没有活动。</p>
    </div>
  </section>
</template>

<style scoped>
.lens-event.selected {
  background: var(--cr-blue-soft);
}
.lens-event-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.lens-title-button {
  border: 0;
  padding: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.lens-opening {
  margin: 0 0 6px;
  font-family: var(--cr-display);
  overflow-wrap: anywhere;
}
.lens-line {
  margin: 6px 0 4px;
  font-size: 12.5px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.lens-checks,
.lens-ops {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 2px;
  font-size: 13px;
}
.lens-checks li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.lens-checks li:hover,
.lens-checks li.selected {
  background: var(--cr-panel-3);
}
.lens-ops li {
  padding-left: 14px;
  position: relative;
  overflow-wrap: anywhere;
}
.lens-ops li::before {
  content: '·';
  position: absolute;
  left: 4px;
}
.lens-met {
  color: var(--cr-context);
}
.lens-unmet {
  color: var(--cr-fail);
}
.lens-removed {
  opacity: 0.6;
  cursor: default;
}
.lens-chosen {
  margin-top: 8px;
}
.lens-chosen header {
  flex-wrap: wrap;
}
.lens-chosen p {
  margin: 0;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
</style>
