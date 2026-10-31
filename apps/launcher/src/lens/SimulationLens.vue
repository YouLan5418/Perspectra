<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { WorldJsonObject } from '@harness-world/contracts'
import type { HostAction } from '../../../../desktop/host/http-server.ts'
import type { LensNpcPlan, LensStep, LensTraceLine } from '../../../../desktop/lens/simulation.ts'
import { useLensStore } from './store.ts'
import SimulationStart from './SimulationStart.vue'

/** 回合推演：真实宿主运行时加桩模型。像玩游戏一样点玩家行动，或跑 AI 写好的推演脚本；每步列出完整经过。 */
const store = useLensStore()
const simulation = computed(() => store.snapshot!.simulation)
const state = computed(() => simulation.value.state)
const nameOf = (id: string) => store.itemById.get(id)?.title ?? id

interface Choice {
  readonly key: string
  readonly label: string
  readonly step: LensStep
}
const object = (value: unknown) => (value ?? {}) as WorldJsonObject
/** 当前可用的玩家行动：移动和交互来自 availableActions，活动操作来自各活动的视图。 */
const choices = computed(() => {
  const moves: Choice[] = []
  const interactions: Choice[] = []
  const activities: Choice[] = []
  for (const affordance of state.value.availableActions ?? []) {
    if (affordance.actionType === 'move')
      for (const destination of affordance.destinations ?? [])
        moves.push({
          key: 'move:' + destination.locationId,
          label: '前往 ' + destination.name,
          step: { kind: 'action', action: { actionType: 'move', parameters: { locationId: destination.locationId } } },
        })
    if (affordance.actionType === 'interact')
      for (const [index, option] of (affordance.interactions ?? []).entries()) {
        const definitionId = String(object(option.definitionRef).id ?? '')
        // 活动操作在下面按活动列出；宿主自己的管理动作不在推演里点。
        if (!option.targetRef || definitionId.startsWith('activity:') || definitionId.startsWith('host:')) continue
        const targetId = String(object(option.targetRef).id ?? '')
        const action: HostAction = {
          actionType: 'interact',
          parameters: {
            targetRef: option.targetRef,
            definitionRef: option.definitionRef ?? {},
            bindingId: option.bindingId ?? '',
            arguments: option.arguments ?? {},
          },
        }
        const authored = state.value.actionLabels?.[String(option.bindingId)]
        interactions.push({
          key: `interact:${index}:${definitionId}:${targetId}`,
          label:
            authored ?? (typeof option.label === 'string' ? option.label : `${definitionId} → ${nameOf(targetId)}`),
          step: { kind: 'action', action },
        })
      }
  }
  for (const view of state.value.activities ?? []) {
    if (view.available === false || view.suspended === true) continue
    const activityKey = String(view.activityKey)
    const request = (operation: string) => ({
      kind: 'activity' as const,
      request: {
        activityKey,
        activityId: typeof view.id === 'string' ? view.id : null,
        revision: typeof view.revision === 'number' ? view.revision : 0,
        operation,
        parameters: {},
      },
    })
    if (object(view.game).active === true) {
      for (const option of (view.options ?? []) as WorldJsonObject[]) {
        const operation = String(object(option.definitionRef).id ?? '').slice('activity:'.length)
        activities.push({ key: `${activityKey}:${operation}`, label: String(option.label), step: request(operation) })
      }
    } else if (Array.isArray(view.quickOperations) && view.quickOperations.length) {
      for (const option of view.quickOperations as WorldJsonObject[])
        activities.push({
          key: `${activityKey}:${String(option.id)}`,
          label: String(option.label),
          step: request(String(option.id)),
        })
    } else if (view.manualStart !== false) {
      activities.push({ key: activityKey + ':start', label: '开始 ' + String(view.title), step: request('start') })
    }
  }
  return { moves, interactions, activities }
})

const speech = ref('')
type PlanKind = 'abstain' | 'say' | 'perform'
const npcs = computed(() => store.inSection('characters').filter(item => item.title !== state.value.world.playerName))
const plans = ref<Record<string, { kind: PlanKind; text: string }>>({})
const resetPlans = () => {
  plans.value = Object.fromEntries(npcs.value.map(item => [item.id, { kind: 'abstain' as PlanKind, text: '' }]))
}
watch(npcs, resetPlans, { immediate: true })
const planProblem = ref('')
function builtPlans(): Record<string, LensNpcPlan[]> {
  const result: Record<string, LensNpcPlan[]> = {}
  for (const [id, plan] of Object.entries(plans.value)) {
    if (plan.kind === 'say' && plan.text.trim()) result[id] = [{ kind: 'say', text: plan.text.trim() }]
    if (plan.kind === 'perform') {
      try {
        result[id] = [{ kind: 'perform', action: JSON.parse(plan.text) as HostAction }]
      } catch {
        throw new Error(`${nameOf(id)} 的行动不是有效的 JSON`)
      }
    }
  }
  return result
}
async function play(step: LensStep) {
  planProblem.value = ''
  let npcPlans: Record<string, LensNpcPlan[]>
  try {
    npcPlans = builtPlans()
  } catch (error) {
    planProblem.value = error instanceof Error ? error.message : String(error)
    return
  }
  if (await store.step(step, npcPlans)) {
    resetPlans()
    if (step.kind === 'say') speech.value = ''
  }
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

      <div class="cr-block">
        <header>
          <strong>玩家此刻可做</strong>
          <span v-if="state.world.currentScene">
            在 {{ state.world.currentScene.locationName }}
            <template v-if="state.world.currentScene.presentNpcNames.length">
              ，同在：{{ state.world.currentScene.presentNpcNames.join('、') }}
            </template>
          </span>
        </header>
        <div class="lens-actions">
          <template v-for="group in [choices.moves, choices.interactions, choices.activities]">
            <button
              v-for="choice in group"
              :key="choice.key"
              class="cr-button"
              :disabled="store.busy"
              @click="play(choice.step)"
            >
              {{ choice.label }}
            </button>
          </template>
          <button v-if="state.canWait" class="cr-button" :disabled="store.busy" @click="play({ kind: 'wait' })">
            静观
          </button>
          <span class="lens-say">
            <input v-model="speech" class="cr-input" placeholder="说一句话" aria-label="玩家说的话" />
            <button
              class="cr-button"
              :disabled="store.busy || !speech.trim()"
              @click="play({ kind: 'say', text: speech.trim() })"
            >
              说
            </button>
          </span>
        </div>
      </div>

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
            <textarea
              v-if="plans[npc.id]?.kind === 'perform'"
              v-model="plans[npc.id]!.text"
              class="cr-input lens-json"
              rows="3"
              placeholder='{"actionType":"interact","parameters":{...}}，照样经过规则裁定'
            ></textarea>
          </div>
          <p v-if="planProblem" class="lens-problem" role="alert">{{ planProblem }}</p>
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
.lens-row,
.lens-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.lens-actions {
  margin: 0;
}
.lens-actions .cr-button {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lens-say {
  display: inline-flex;
  gap: 4px;
  min-width: 0;
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
.lens-json {
  flex: 1 1 260px;
  height: auto;
  padding: 6px 8px;
  font-family: var(--cr-mono);
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
