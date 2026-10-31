<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { HostAction } from '../../../../desktop/host/http-server.ts'
import type { LensStep } from '../../../../desktop/lens/simulation.ts'
import { useLensStore } from './store.ts'

/** 玩家此刻可做的事：移动和交互来自 availableActions，活动操作来自各活动的视图。需要参数的操作按 schema 给出输入框；
 * 结构太复杂的显示原因并禁用，绝不悄悄发送空参数。 */
const emit = defineEmits<{ play: [step: LensStep] }>()
const store = useLensStore()
const state = computed(() => store.snapshot!.simulation.state)
const nameOf = (id: string) => store.itemById.get(id)?.title ?? id
const object = (value: unknown) => (value ?? {}) as WorldJsonObject

interface Field {
  readonly key: string
  readonly label: string
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'npcs'
  readonly required: boolean
  readonly options?: readonly { readonly value: string; readonly label: string }[]
  readonly min?: number
  readonly max?: number
}
interface Choice {
  readonly key: string
  readonly label: string
  readonly step: (values: Record<string, unknown>) => LensStep
  readonly fields?: readonly Field[]
  /** Set when the lens cannot offer the inputs this operation needs. */
  readonly blocked?: string
}

/** 活动操作的输入框：只认 string/number/integer/boolean/enum 的扁平参数，其余视为太复杂。 */
function schemaFields(option: WorldJsonObject): { fields: Field[]; blocked?: string } {
  const schema = object(option.argumentSchema)
  const fixed = object(option.arguments)
  const required = new Set((schema.required as string[] | undefined) ?? [])
  const fields: Field[] = []
  for (const [key, raw] of Object.entries(object(schema.properties))) {
    if (Object.hasOwn(fixed, key)) continue
    const property = object(raw)
    const label = typeof property.title === 'string' ? property.title : key
    if (Array.isArray(property.enum))
      fields.push({
        key,
        label,
        kind: 'enum',
        required: required.has(key),
        options: property.enum.map(value => ({ value: JSON.stringify(value), label: String(value) })),
      })
    else if (property.type === 'string') fields.push({ key, label, kind: 'string', required: required.has(key) })
    else if (property.type === 'number' || property.type === 'integer')
      fields.push({ key, label, kind: 'number', required: required.has(key) })
    else if (property.type === 'boolean') fields.push({ key, label, kind: 'boolean', required: required.has(key) })
    else return { fields, blocked: `参数“${label}”结构较复杂，请用推演脚本填写` }
  }
  return { fields }
}

const choices = computed(() => {
  const list: Choice[] = []
  for (const affordance of state.value.availableActions ?? []) {
    if (affordance.actionType === 'move')
      for (const destination of affordance.destinations ?? []) {
        const step: LensStep = {
          kind: 'action',
          action: { actionType: 'move', parameters: { locationId: destination.locationId } },
        }
        list.push({ key: 'move:' + destination.locationId, label: '前往 ' + destination.name, step: () => step })
      }
    if (affordance.actionType === 'interact')
      for (const [index, option] of (affordance.interactions ?? []).entries()) {
        const definitionId = String(object(option.definitionRef).id ?? '')
        // 活动操作在下面按活动列出；宿主自己的管理动作不在这里点。
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
        list.push({
          key: `interact:${index}:${definitionId}:${targetId}`,
          label:
            authored ?? (typeof option.label === 'string' ? option.label : `${definitionId} → ${nameOf(targetId)}`),
          step: () => ({ kind: 'action', action }),
        })
      }
  }
  for (const view of state.value.activities ?? []) {
    if (view.available === false) continue
    const activityKey = String(view.activityKey)
    const title = String(view.title ?? activityKey)
    const request = (operation: string, parameters: WorldJsonObject = {}): LensStep => ({
      kind: 'activity',
      request: {
        activityKey,
        activityId: typeof view.id === 'string' ? view.id : null,
        revision: typeof view.revision === 'number' ? view.revision : 0,
        operation,
        parameters,
      },
    })
    if (view.suspended === true) {
      // 与玩家页面一样：暂停中的活动可以继续或放弃。
      list.push({ key: activityKey + ':resume', label: '继续 ' + title, step: () => request('resume') })
      list.push({ key: activityKey + ':abandon', label: '放弃 ' + title, step: () => request('abandon') })
    } else if (object(view.game).active === true) {
      for (const option of (view.options ?? []) as WorldJsonObject[]) {
        const id = String(object(option.definitionRef).id ?? '')
        if (!id.startsWith('activity:')) continue
        const operation = id.slice('activity:'.length)
        const { fields, blocked } = schemaFields(option)
        list.push({
          key: `${activityKey}:${operation}`,
          label: typeof option.label === 'string' ? option.label : operation,
          fields,
          ...(blocked ? { blocked } : {}),
          step: values => request(operation, values as WorldJsonObject),
        })
      }
    } else if (Array.isArray(view.quickOperations) && view.quickOperations.length) {
      for (const option of view.quickOperations as WorldJsonObject[]) {
        const operation = String(option.id)
        list.push({
          key: `${activityKey}:${operation}`,
          label: typeof option.label === 'string' ? option.label : operation,
          step: () => request(operation),
        })
      }
    } else if (view.manualStart !== false) {
      const selection = view.participantSelection as
        | { min: number; max: number; candidates: { id: string; name: string }[] }
        | undefined
      list.push({
        key: activityKey + ':start',
        label: '开始 ' + title,
        ...(selection
          ? {
              fields: [
                {
                  key: 'npcIds',
                  label: `选 ${selection.min}–${selection.max} 位参与者`,
                  kind: 'npcs',
                  required: true,
                  options: selection.candidates.map(c => ({ value: c.id, label: c.name })),
                  min: selection.min,
                  max: selection.max,
                },
              ],
            }
          : {}),
        step: values => request('start', values as WorldJsonObject),
      })
    }
  }
  return list
})

const drafts = ref<Record<string, Record<string, string | boolean | string[]>>>({})
watch(
  choices,
  list => {
    for (const choice of list) drafts.value[choice.key] ??= {}
  },
  { immediate: true },
)
const draft = (choice: Choice) => drafts.value[choice.key] ?? {}
/** 把输入框的内容变成参数；不完整时返回原因。 */
function parameters(choice: Choice): Record<string, WorldJsonValue> | string {
  const values = draft(choice)
  const result: Record<string, WorldJsonValue> = {}
  for (const field of choice.fields ?? []) {
    const value = values[field.key]
    if (field.kind === 'npcs') {
      const ids = Array.isArray(value) ? value : []
      if (ids.length < (field.min ?? 0) || ids.length > (field.max ?? Infinity)) return field.label
      result[field.key] = ids
    } else if (field.kind === 'boolean') {
      if (value !== undefined || field.required) result[field.key] = value === true
    } else if (typeof value === 'string' && value !== '') {
      if (field.kind === 'number') {
        const number = Number(value)
        if (!Number.isFinite(number)) return `${field.label}需要数字`
        result[field.key] = number
      } else result[field.key] = field.kind === 'enum' ? (JSON.parse(value) as WorldJsonValue) : value
    } else if (field.required) return `请填写${field.label}`
  }
  return result
}
function run(choice: Choice) {
  const values = parameters(choice)
  if (typeof values === 'string') return
  emit('play', choice.step(values))
  drafts.value[choice.key] = {}
}

const simple = computed(() => choices.value.filter(choice => !choice.fields?.length && !choice.blocked))
const detailed = computed(() => choices.value.filter(choice => choice.fields?.length || choice.blocked))
const speech = ref('')
function say() {
  emit('play', { kind: 'say', text: speech.value.trim() })
  speech.value = ''
}
</script>

<template>
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
      <button v-for="choice in simple" :key="choice.key" class="cr-button" :disabled="store.busy" @click="run(choice)">
        {{ choice.label }}
      </button>
      <button v-if="state.canWait" class="cr-button" :disabled="store.busy" @click="emit('play', { kind: 'wait' })">
        静观
      </button>
      <span class="lens-say">
        <input v-model="speech" class="cr-input" placeholder="说一句话" aria-label="玩家说的话" />
        <button class="cr-button" :disabled="store.busy || !speech.trim()" @click="say()">说</button>
      </span>
    </div>
    <div v-for="choice in detailed" :key="choice.key" class="lens-form">
      <strong>{{ choice.label }}</strong>
      <span v-if="choice.blocked" class="cr-muted">{{ choice.blocked }}</span>
      <template v-else>
        <template v-for="field in choice.fields" :key="field.key">
          <span v-if="field.kind === 'npcs'" class="lens-form-field">
            <span>{{ field.label }}</span>
            <label v-for="option in field.options" :key="option.value" class="lens-check">
              <input
                type="checkbox"
                :value="option.value"
                :checked="((draft(choice)[field.key] as string[] | undefined) ?? []).includes(option.value)"
                @change="
                  draft(choice)[field.key] = ($event.target as HTMLInputElement).checked
                    ? [...((draft(choice)[field.key] as string[] | undefined) ?? []), option.value]
                    : ((draft(choice)[field.key] as string[] | undefined) ?? []).filter(id => id !== option.value)
                "
              />{{ option.label }}
            </label>
          </span>
          <label v-else-if="field.kind === 'boolean'" class="lens-check">
            <input v-model="draft(choice)[field.key]" type="checkbox" />{{ field.label }}
          </label>
          <label v-else class="lens-form-field">
            <span>{{ field.label }}{{ field.required ? '' : '（可选）' }}</span>
            <select v-if="field.kind === 'enum'" v-model="draft(choice)[field.key]" class="cr-select">
              <option value="">请选择</option>
              <option v-for="option in field.options" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <input
              v-else
              v-model="draft(choice)[field.key]"
              class="cr-input"
              :inputmode="field.kind === 'number' ? 'decimal' : 'text'"
            />
          </label>
        </template>
        <span v-if="typeof parameters(choice) === 'string'" class="cr-muted">{{ parameters(choice) }}</span>
        <button class="cr-button" :disabled="store.busy || typeof parameters(choice) === 'string'" @click="run(choice)">
          执行
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lens-actions,
.lens-form {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.lens-form {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--cr-line);
  font-size: 12.5px;
}
.lens-actions .cr-button {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lens-say,
.lens-form-field,
.lens-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex-wrap: wrap;
}
</style>
