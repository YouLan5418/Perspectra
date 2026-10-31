<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { WorldJsonValue } from '@harness-world/contracts'
import type { LensStart } from '../../../../desktop/lens/simulation.ts'
import { useLensStore } from './store.ts'
import { fieldValue, showValue } from './format.ts'

/** 推演起点：当作“另一种开场”，在推演运行时启动前改写临时副本。可选项全部来自透视结果里的状态、地点和事件。 */
const store = useLensStore()
const start = computed<LensStart>(() => store.snapshot?.simulation.start ?? {})

const statuses = computed(() =>
  store
    .inSection('statuses')
    .filter(item => fieldValue(item.fields, 'owner') === 'public')
    .map(item => ({
      key: String(fieldValue(item.fields, 'key')),
      type: String(fieldValue(item.fields, 'type')),
      label: item.title,
      opening: fieldValue(item.fields, 'opening'),
    })),
)
/** 起点按场景安排角色；一个地点取它的第一个场景。 */
const places = computed(() =>
  store.inSection('places').flatMap(item => {
    const scenes = fieldValue(item.fields, 'scenes')
    const sceneId = Array.isArray(scenes) ? scenes[0] : undefined
    return sceneId === undefined ? [] : [{ sceneId, name: item.title }]
  }),
)
const characters = computed(() => store.inSection('characters'))
const autoStartEvents = computed(() =>
  store
    .inSection('events')
    .filter(item => item.parentId === undefined && fieldValue(item.fields, 'autoStart') === true)
    .map(item => ({ key: item.id.slice('event:'.length), title: item.title })),
)

const values = ref<Record<string, string>>({})
const scenes = ref<Record<string, string>>({})
const skipped = ref<string[]>([])
const problem = ref('')
watch(
  start,
  current => {
    const show = (value: WorldJsonValue) => (typeof value === 'string' ? value : JSON.stringify(value))
    values.value = Object.fromEntries(Object.entries(current.status?.public ?? {}).map(([k, v]) => [k, show(v)]))
    scenes.value = { ...current.scenes }
    skipped.value = [...(current.skipAutoStart ?? [])]
  },
  { immediate: true },
)

function parse(type: string, text: string): WorldJsonValue {
  if (type === 'string') return text
  if (type === 'number') {
    const number = Number(text)
    if (!Number.isFinite(number)) throw new Error(`“${text}”不是数字`)
    return number
  }
  if (type === 'boolean') return text === 'true'
  return JSON.parse(text) as WorldJsonValue
}
function build(): LensStart {
  const status: Record<string, WorldJsonValue> = {}
  for (const { key, type, label } of statuses.value) {
    const text = values.value[key] ?? ''
    if (text === '') continue
    try {
      status[key] = parse(type, text)
    } catch (error) {
      throw new Error(`${label}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const placed = Object.fromEntries(Object.entries(scenes.value).filter(([, sceneId]) => sceneId !== ''))
  return {
    ...(Object.keys(status).length ? { status: { public: status } } : {}),
    ...(Object.keys(placed).length ? { scenes: placed } : {}),
    ...(skipped.value.length ? { skipAutoStart: [...skipped.value] } : {}),
  }
}
async function restart(from?: LensStart) {
  problem.value = ''
  try {
    await store.restart(from ?? build())
  } catch (error) {
    problem.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <details class="cr-block lens-start" :open="!store.snapshot?.simulation.trace.length">
    <summary><strong>起点</strong> <span class="cr-muted">留空的项按包的正常开场</span></summary>
    <div class="lens-start-body">
      <fieldset v-if="statuses.length">
        <legend>公共状态</legend>
        <label v-for="status in statuses" :key="status.key" class="lens-start-field">
          <span>{{ status.label }}</span>
          <select v-if="status.type === 'boolean'" v-model="values[status.key]" class="cr-select">
            <option value="">按开场（{{ showValue(status.opening ?? null) }}）</option>
            <option value="true">是</option>
            <option value="false">否</option>
          </select>
          <input
            v-else
            v-model="values[status.key]"
            class="cr-input"
            :placeholder="'开场：' + showValue(status.opening ?? null)"
          />
        </label>
      </fieldset>
      <fieldset v-if="places.length">
        <legend>角色所在场景</legend>
        <label v-for="character in characters" :key="character.id" class="lens-start-field">
          <span>{{ character.title }}</span>
          <select v-model="scenes[character.id]" class="cr-select">
            <option value="">按开场</option>
            <option v-for="place in places" :key="place.sceneId" :value="place.sceneId">{{ place.name }}</option>
          </select>
        </label>
      </fieldset>
      <fieldset v-if="autoStartEvents.length">
        <legend>跳过自动开始</legend>
        <label v-for="event in autoStartEvents" :key="event.key" class="lens-check">
          <input v-model="skipped" type="checkbox" :value="event.key" />{{ event.title }}
        </label>
      </fieldset>
      <p v-if="problem" class="lens-problem" role="alert">{{ problem }}</p>
      <div class="lens-start-actions">
        <button class="cr-button primary" :disabled="store.busy" @click="restart()">从这个起点重新推演</button>
        <button class="cr-button" :disabled="store.busy" @click="restart({})">回到包的开场</button>
      </div>
    </div>
  </details>
</template>

<style scoped>
.lens-start summary {
  cursor: pointer;
  padding: 6px 10px;
  font-size: 12.5px;
}
.lens-start-body {
  display: grid;
  gap: 10px;
}
fieldset {
  margin: 0;
  padding: 0;
  border: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr));
  gap: 6px 12px;
}
legend {
  padding: 0 0 4px;
  font-size: 12px;
  color: var(--cr-dim);
}
.lens-start-field {
  display: grid;
  grid-template-columns: minmax(0, 6em) minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}
.lens-start-field .cr-input,
.lens-start-field .cr-select {
  width: 100%;
}
.lens-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}
.lens-start-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.lens-problem {
  margin: 0;
  color: var(--cr-fail);
  font-size: 12.5px;
}
</style>
