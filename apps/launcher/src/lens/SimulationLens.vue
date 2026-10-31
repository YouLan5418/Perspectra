<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { LensNpcPlan, LensStep, LensTraceLine } from '../../../../desktop/lens/simulation.ts'
import { useLensStore } from './store.ts'
import SimulationStart from './SimulationStart.vue'
import SimulationActions from './SimulationActions.vue'

/** 回合推演：真实宿主运行时加桩模型。像玩游戏一样点玩家行动，或跑 AI 写好的推演脚本；每步列出完整经过。 */
const store = useLensStore()
const simulation = computed(() => store.snapshot!.simulation)
const nameOf = (id: string) => store.itemById.get(id)?.title ?? id

type PlanKind = 'abstain' | 'say' | 'perform'
/** 非玩家角色：运行时为她们算出了此刻能做的事。 */
const npcs = computed(() => store.inSection('characters').filter(item => item.id in simulation.value.npcOptions))
const options = (id: string) => simulation.value.npcOptions[id] ?? []
const optionLabel = (option: ReturnType<typeof options>[number]) =>
  option.label + (option.targetName && option.targetId !== undefined ? ' → ' + option.targetName : '')
/** 尝试交互只能从运行时此刻给她的选项里挑，`option` 是选项序号。 */
const plans = ref<Record<string, { kind: PlanKind; text: string; option: number }>>({})
const resetPlans = () => {
  plans.value = Object.fromEntries(
    npcs.value.map(item => [item.id, { kind: 'abstain' as PlanKind, text: '', option: 0 }]),
  )
}
watch(npcs, resetPlans, { immediate: true })
function builtPlans(): Record<string, LensNpcPlan[]> {
  const result: Record<string, LensNpcPlan[]> = {}
  for (const [id, plan] of Object.entries(plans.value)) {
    if (plan.kind === 'say' && plan.text.trim()) result[id] = [{ kind: 'say', text: plan.text.trim() }]
    const chosen = options(id)[plan.option]
    if (plan.kind === 'perform' && chosen) result[id] = [{ kind: 'perform', action: chosen.action }]
  }
  return result
}
async function play(step: LensStep) {
  if (await store.step(step, builtPlans())) resetPlans()
}

const scenario = ref('')
watch(
  () => store.snapshot?.scenarios,
  names => {
    if (!names?.includes(scenario.value)) scenario.value = names?.[0] ?? ''
  },
  { immediate: true },
)

const KIND: Record<LensTraceLine['kind'], string> = {
  input: '输入',
  resolved: '裁定',
  rejected: '拒绝',
  moved: '移动',
  speech: '说话',
  item: '物品',
  status: '状态',
  'round-hook': '回合钩子',
  activity: '活动',
}
const TONE: Partial<Record<LensTraceLine['kind'], string>> = {
  rejected: 'danger',
  status: 'warn',
  'round-hook': 'warn',
}
const trace = computed(() => [...simulation.value.trace].reverse())
</script>

<template>
  <section class="cr-center">
    <p class="cr-banner warn lens-notice" role="note">推演只验证规则与触发，不代表角色表现，请仍以真实试玩验收对白。</p>
    <div class="cr-scroll lens-sim">
      <div class="lens-row">
        <label class="cr-field">
          推演脚本
          <select v-model="scenario" class="cr-select" :disabled="!store.snapshot?.scenarios.length">
            <option v-if="!store.snapshot?.scenarios.length" value="">（.perspectra-lens/scenarios 下没有脚本）</option>
            <option v-for="name in store.snapshot?.scenarios" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <button class="cr-button" :disabled="store.busy || !scenario" @click="store.runScenario(scenario)">运行</button>
      </div>

      <SimulationStart />

      <SimulationActions @play="play" />

      <details v-if="npcs.length" class="cr-block">
        <summary class="lens-summary">
          <strong>NPC 本步行为</strong> <span class="cr-muted">默认弃权；获得机会时才会用到</span>
        </summary>
        <div class="lens-npcs">
          <div v-for="npc in npcs" :key="npc.id" class="lens-npc">
            <span>{{ npc.title }}</span>
            <select v-if="plans[npc.id]" v-model="plans[npc.id]!.kind" class="cr-select">
              <option value="abstain">弃权</option>
              <option value="say">说一句</option>
              <option value="perform">尝试交互</option>
            </select>
            <input
              v-if="plans[npc.id]?.kind === 'say'"
              v-model="plans[npc.id]!.text"
              class="cr-input"
              placeholder="她要说的话"
            />
            <template v-if="plans[npc.id]?.kind === 'perform'">
              <select v-if="options(npc.id).length" v-model="plans[npc.id]!.option" class="cr-select lens-option">
                <option v-for="(option, index) in options(npc.id)" :key="index" :value="index">
                  {{ optionLabel(option) }}
                </option>
              </select>
              <span v-else class="cr-muted">此刻没有可尝试的交互</span>
              <span class="cr-muted">选项是她主动时（轮到她自己行动的回合）可以做的事</span>
            </template>
          </div>
        </div>
      </details>

      <h3 class="lens-heading">逐步经过（最新在上）</h3>
      <p v-if="!trace.length" class="cr-empty">还没有推演。点上面的行动走一步，或运行推演脚本。</p>
      <article v-for="step in trace" :key="step.index" class="cr-block">
        <header>
          <strong>第 {{ step.index + 1 }} 步</strong>
          <span v-if="step.activated.length">获得机会：{{ step.activated.map(nameOf).join('、') }}</span>
        </header>
        <div class="lens-step">
          <p v-if="step.error" class="lens-problem">出错：{{ step.error }}</p>
          <p v-for="evaluation in step.autoStart" :key="evaluation.activityKey" class="lens-auto">
            <span v-if="evaluation.started" class="cr-tag ok">触发</span>
            <span v-else class="cr-tag muted">未触发</span>
            {{ evaluation.title }}
            <template v-if="!evaluation.started && evaluation.checks">
              ：<span
                v-for="(check, position) in evaluation.checks.filter(c => !c.met)"
                :key="position"
                class="lens-unmet"
              >
                ✘ {{ check.label ?? '条件 ' + (evaluation.checks.indexOf(check) + 1) }}
              </span>
            </template>
            <span v-if="evaluation.error" class="lens-problem">{{ evaluation.error }}</span>
          </p>
          <p v-for="line in step.lines" :key="line.seq + line.kind + line.text" class="lens-line">
            <span class="cr-tag" :class="TONE[line.kind] ?? 'line'">{{ KIND[line.kind] }}</span>
            <span>{{ line.text }}</span>
          </p>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.lens-notice {
  flex: 0 0 auto;
}
.lens-sim {
  padding: 10px 12px 24px;
}
.lens-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.lens-summary {
  cursor: pointer;
  padding: 6px 10px;
  font-size: 12.5px;
}
.lens-npcs {
  display: grid;
  gap: 6px;
}
.lens-npc {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.lens-npc > span {
  min-width: 5em;
}
.lens-option {
  max-width: 100%;
}
.lens-heading {
  margin: 14px 0 6px;
  font-size: 12.5px;
  color: var(--cr-dim);
}
.lens-step p {
  margin: 0 0 3px;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.lens-line {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.lens-auto {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.lens-unmet,
.lens-problem {
  color: var(--cr-fail);
}
</style>
