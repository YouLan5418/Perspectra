<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  eventVariables,
  parseWorldVariable,
  type WorldVariableDefinition as EditorVariable,
  type WorldRecord,
} from '@perspectra/world-pack/editor-fields'
import { editorRequest } from './editor-api.ts'
import EventConditions from './EventConditions.vue'
import EventGrants from './EventGrants.vue'
import type { eventOptions } from '../../../host/src/editor/event-options.ts'
import VariableFields from './VariableFields.vue'
import type { EditorProject } from '../../../host/src/editor/project.ts'
import type { RuleRow, PaceRow } from '../../../host/src/editor/rule-source.ts'
import type { ruleReferences } from '../../../host/src/editor/rules.ts'
import type { playRules } from '../../../host/src/editor/export.ts'
const props = defineProps<{
  records: WorldRecord[]
  initialEvent?: string | undefined
  initialVariable?: string | undefined
}>()
const emit = defineEmits<{
  activity: [key: string, choice: string, field: string, reference: string]
  knowledge: [id: string]
}>()
type RefRow =
  | ReturnType<typeof ruleReferences>[number]
  | { section: 'knowledge'; id: string; label: string; field: string }
type Kind = 'variable' | 'event' | 'pacing'
const labels = { variable: '世界变量', event: '世界事件', pacing: '事件节奏表' } as const
const data = ref<EditorProject['rules']>({ variables: [], events: [], pacing: [] }),
  tab = ref<Kind>('variable')
const variable = ref<EditorVariable>({ key: '', label: '', type: 'boolean', initial: false })
const event = ref<RuleRow>({
  id: '',
  type: '',
  observation: '',
  location: '',
  round: 1,
  set: { key: '', value: false },
})
const pace = ref<PaceRow>({ id: '', intensity: 'medium' })
const base = ref<EditorVariable | RuleRow | PaceRow | null>(null),
  baseline = ref(''),
  active = ref(false),
  readOnly = ref(false)
type RuleValue = EditorVariable | RuleRow | PaceRow
const conflict = ref<{ base: RuleValue | null; current: RuleValue; proposed: RuleValue }>()
const newFlag = ref<EditorVariable>()
const busy = ref(false),
  error = ref(''),
  notice = ref(''),
  search = ref(''),
  eventSearch = ref('')
const refs = ref<RefRow[]>([]),
  rounds = ref(1),
  trial = ref<Awaited<ReturnType<typeof playRules>>>()
const returnPace = ref<PaceRow>()
const rows = computed(() =>
  (tab.value === 'variable'
    ? data.value.variables.map(v => ({ id: v.key, label: v.label }))
    : tab.value === 'event'
      ? data.value.events.map(e => ({ id: e.id, label: e.observation }))
      : data.value.pacing.map(p => ({
          id: p.id,
          label: data.value.events.find(e => e.id === p.id)?.observation ?? p.id,
        }))
  ).filter(r => (r.label + ' ' + r.id).toLowerCase().includes(search.value.toLowerCase())),
)
const row = computed(() =>
  tab.value === 'variable' ? variable.value : tab.value === 'event' ? event.value : pace.value,
)
const id = computed(() =>
  tab.value === 'variable' ? variable.value.key : tab.value === 'event' ? event.value.id : pace.value.id,
)
const dirty = computed(() => active.value && !readOnly.value && JSON.stringify(row.value) !== baseline.value)
const locs = computed(() => props.records.filter(r => r.kind === 'location'))
const options = ref<Awaited<ReturnType<typeof eventOptions>>>()
const subscriptions = ref<InstanceType<typeof EventGrants>>()
const flags = computed(() => eventVariables(data.value.variables))
const eligible = computed(() =>
  data.value.events.filter(
    e => e.id === pace.value.id || (e.observation + ' ' + e.id).toLowerCase().includes(eventSearch.value.toLowerCase()),
  ),
)
const name = (key: string) => props.records.find(r => r.id === key)?.name ?? key
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
async function refresh() {
  data.value = (await editorRequest<EditorProject>('open')).rules
}
async function load(kind: Kind, key?: string) {
  newFlag.value = undefined
  conflict.value = undefined
  tab.value = kind
  active.value = true
  readOnly.value = false
  base.value = null
  refs.value = []
  if (kind === 'variable') {
    const selected = data.value.variables.find(r => r.key === key)
    readOnly.value = !!selected && !selected.editable
    variable.value = selected
      ? copy(selected.editable ? parseWorldVariable(selected) : selected)
      : { key: '', label: '', type: 'boolean', initial: false }
    if (selected) base.value = copy(variable.value)
  } else if (kind === 'event') {
    options.value = await editorRequest('event-candidates')
    const selected = data.value.events.find(r => r.id === key)
    event.value = selected
      ? copy(selected)
      : {
          id: '',
          type: '',
          trigger: 'hard',
          location: locs.value[0]?.id ?? '',
          round: 1,
          observation: '',
          set: { key: flags.value[0]?.key ?? '', value: false },
        }
    if (selected) base.value = copy(selected)
  } else {
    const selected = data.value.pacing.find(r => r.id === key)
    pace.value = selected ? copy(selected) : { id: '', intensity: 'medium' }
    if (selected) base.value = copy(selected)
  }
  baseline.value = JSON.stringify(row.value)
  if (key && kind !== 'pacing') {
    refs.value = await editorRequest('rule-references', { kind: kind === 'variable' ? 'world' : 'event', id: key })
    if (kind === 'variable')
      refs.value.push(...(await editorRequest<RefRow[]>('knowledge-references', { kind: 'world', id: key })))
  }
}
async function run(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await fn()
  } catch (e) {
    const detail = e as { status?: number; details?: typeof conflict.value }
    if (detail.status === 409 && detail.details?.current && detail.details?.proposed) conflict.value = detail.details
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function save() {
  try {
    await subscriptions.value?.flush()
  } catch (e) {
    throw new Error((e as Error).message)
  }
  if (newFlag.value) throw new Error('请先保存或取消新建的布尔变量')
  if (conflict.value) throw new Error('请先处理规则的并发修改')
  if (!active.value || readOnly.value || !dirty.value) return
  const key = id.value
  data.value = await editorRequest('rule-save', { kind: tab.value, base: base.value, row: row.value })
  await load(tab.value, key)
  if (returnPace.value && tab.value === 'event') {
    const prior = returnPace.value
    returnPace.value = undefined
    await load('pacing')
    pace.value = { ...prior, id: key }
  }
  notice.value = '已保存'
}
function resolveConflict(keep: boolean) {
  const details = conflict.value
  if (!details) return
  const current = copy(details.current)
  const result = { ...current } as Record<string, unknown>
  if (keep) {
    const original = (details.base ?? {}) as Record<string, unknown>,
      proposed = details.proposed as unknown as Record<string, unknown>
    for (const k of new Set([...Object.keys(original), ...Object.keys(proposed)])) {
      if (JSON.stringify(original[k]) === JSON.stringify(proposed[k])) continue
      if (k in proposed) result[k] = proposed[k]
      else delete result[k]
    }
  }
  base.value = current
  baseline.value = JSON.stringify(current)
  if (tab.value === 'variable') variable.value = result as unknown as EditorVariable
  else if (tab.value === 'event') event.value = result as unknown as RuleRow
  else pace.value = result as unknown as PaceRow
  conflict.value = undefined
  error.value = ''
  notice.value = keep ? '已带入修改，请核对后保存' : '已采用并发保存的版本'
}
async function addFlag() {
  await run(async () => {
    if (!newFlag.value) return
    const v = parseWorldVariable({ ...newFlag.value, type: 'boolean' })
    try {
      data.value = await editorRequest('rule-save', { kind: 'variable', base: null, row: v })
    } catch (e) {
      if ((e as { status?: number }).status === 409) throw new Error('该变量键已存在，请取消新建后从列表选用，或另取键')
      throw e
    }
    event.value.set.key = v.key
    newFlag.value = undefined
  })
}
async function select(kind: Kind, key?: string, first = false) {
  await run(async () => {
    await save()
    returnPace.value = undefined
    search.value = ''
    eventSearch.value = ''
    await refresh()
    tab.value = kind
    await load(kind, first ? rows.value[0]?.id : key)
  })
}
async function createPaced() {
  await run(async () => {
    returnPace.value = copy(pace.value)
    await load('event')
    event.value.trigger = 'paced'
    event.value.observation = eventSearch.value
  })
}
function reset() {
  void run(async () => {
    const prior = returnPace.value
    returnPace.value = undefined
    if (prior) {
      await load('pacing')
      pace.value = prior
    } else {
      await refresh()
      await load(tab.value, base.value ? id.value : undefined)
    }
  })
}
async function follow(r: RefRow) {
  if (r.section === 'activity') emit('activity', r.id, r.choice!, r.field, 'world/' + id.value)
  else if (r.section === 'knowledge') emit('knowledge', r.id)
  else await select(r.section, r.id)
}
async function play() {
  await run(async () => {
    await save()
    trial.value = await editorRequest('rule-play', { rounds: rounds.value })
  })
}
function wakes(ids: string[]) {
  if (ids.length) event.value.wakeCharacters = ids
  else delete event.value.wakeCharacters
}
defineExpose({
  async flush() {
    if (busy.value) throw new Error('请等当前规则操作完成')
    await save()
    if (returnPace.value || dirty.value) throw new Error('请先完成或取消当前节奏配置')
  },
})
onMounted(() =>
  run(async () => {
    await refresh()
    if (props.initialEvent) await load('event', props.initialEvent)
    else await load('variable', props.initialVariable ?? data.value.variables[0]?.key)
  }),
)
</script>
<template>
  <div class="rule-desk">
    <header>
      <h2>变量与世界事件</h2>
      <div role="group" aria-label="规则分类">
        <button v-for="(label, k) in labels" :key="k" :aria-pressed="tab === k" @click="select(k, undefined, true)">
          {{ label }}
        </button>
      </div>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <aside v-if="conflict">
      <h3>这条规则已被其他编辑修改</h3>
      <details>
        <summary>查看已保存值和本次建议</summary>
        <pre>{{ JSON.stringify(conflict.current, null, 2) }}</pre>
        <pre>{{ JSON.stringify(conflict.proposed, null, 2) }}</pre>
      </details>
      <button @click="resolveConflict(true)">在最新记录上核对本次修改</button
      ><button @click="resolveConflict(false)">采用已保存值</button>
    </aside>
    <p v-if="notice" role="status">{{ notice }}</p>
    <fieldset :disabled="busy">
      <section class="index">
        <label>查找记录<input type="search" v-model="search" placeholder="按名称或键查找" /></label
        ><button @click="select(tab)">新建{{ labels[tab] }}</button
        ><button v-for="r in rows" class="entry" :key="r.id" :aria-pressed="r.id === id" @click="select(tab, r.id)">
          <b>{{ r.label }}</b
          ><small>{{ r.id }}</small>
        </button>
      </section>
      <section class="detail" v-if="active">
        <h3>{{ base ? '编辑' : '新建' }}{{ labels[tab] }}</h3>
        <template v-if="tab === 'variable'"
          ><p v-if="readOnly">{{ variable.label }} · {{ variable.key }}　源脚本声明，定义见 scripts/status.js。</p>
          <template v-else
            ><VariableFields v-model="variable" :locked="!!base" /><label
              >角色何时知道当前值<select
                :value="variable.alwaysKnown === false ? 'revealed' : 'known'"
                @change="variable.alwaysKnown = ($event.target as HTMLSelectElement).value === 'known'"
              >
                <option value="known">所有角色始终知道</option>
                <option value="revealed">由规则单独告知</option>
              </select></label
            ></template
          ></template
        >
        <template v-if="tab === 'event'">
          <EventGrants v-if="options" ref="subscriptions" :options="options" />
          <figure v-if="base" class="event-flow" aria-label="世界事件流程">
            <div>
              {{ event.when ? '日历达到门槛' : event.trigger === 'paced' ? '节奏选中' : '固定回合' }} →
              {{ name(event.location) }} · {{ event.id }}
            </div>
            <ul>
              <li>
                写入 {{ flags.find(v => v.key === event.set.key)?.label ?? event.set.key }} =
                {{ event.set.value ? '是' : '否' }}
              </li>
              <li>
                {{
                  event.audience === 'global'
                    ? '全世界'
                    : !event.audience || event.audience === 'scene'
                      ? '现场角色'
                      : '符合观察条件的角色'
                }}收到观察文字
              </li>
              <li v-if="event.wakeCharacters?.length">
                符合唤醒条件的观察者中，{{ event.wakeCharacters.map(name).join('、') }} 可获决策机会
              </li>
            </ul>
          </figure>
          <label>事件键（必填）<input v-model="event.id" :disabled="!!base" placeholder="porch-blackout" /></label>
          <label
            >事件类型（必填）<input v-model="event.type" list="known-event-types" placeholder="power.outage@1"
          /></label>
          <datalist id="known-event-types"><option v-for="t in options?.types" :key="t" :value="t" /></datalist>
          <label
            >发生地点（必填）<select v-model="event.location">
              <option
                v-for="l in locs"
                :key="l.id"
                :disabled="event.sceneNotices?.some(n => n.locations.includes(l.id))"
                :value="l.id"
              >
                {{ l.name }}
              </option>
            </select></label
          >
          <EventConditions v-if="options" :row="event" :options="options" @change="v => (event = v)" />
          <label>观察文字（必填）<textarea v-model="event.observation" maxlength="512" /></label>
          <label
            >唤醒角色（可选，可多选）<select
              multiple
              :value="event.wakeCharacters ?? []"
              @change="wakes(Array.from(($event.target as HTMLSelectElement).selectedOptions, o => o.value))"
            >
              <option v-for="a in options?.actors" :value="a.id" :key="a.id">{{ a.name }}</option>
            </select></label
          >
          <label
            >写入状态（必填）<select v-model="event.set.key">
              <option v-if="!flags.length" value="">先在世界变量中创建布尔变量</option>
              <option v-for="v in flags" :key="v.key" :value="v.key">{{ v.label }} · {{ v.key }}</option>
            </select></label
          ><button @click="newFlag = { key: '', label: '', initial: false, type: 'boolean' }">新建布尔变量</button>
          <section v-if="newFlag">
            <label>新布尔变量的键<input v-model="newFlag.key" /></label
            ><label>新布尔变量的名称<input v-model="newFlag.label" /></label
            ><label
              >布尔初值<select v-model="newFlag.initial">
                <option :value="true">是</option>
                <option :value="false">否</option>
              </select></label
            ><button @click="addFlag">创建变量并选用</button><button @click="newFlag = undefined">取消新变量</button>
          </section>
          <label
            >写入值<select v-model="event.set.value">
              <option :value="true">是</option>
              <option :value="false">否</option>
            </select></label
          >
        </template>
        <template v-if="tab === 'pacing'"
          ><label>查找事件<input type="search" v-model="eventSearch" /></label
          ><label
            >事件（必填）<select v-model="pace.id" :disabled="!!base">
              <option value="">选择节奏事件</option>
              <option v-for="e in eligible" :key="e.id" :value="e.id" :disabled="e.trigger !== 'paced'">
                {{ e.observation }} · {{ e.id }}{{ e.trigger === 'paced' ? '' : ' · 固定触发，不适用于节奏表' }}
              </option>
            </select></label
          >
          <button v-if="!base" @click="createPaced">新建节奏事件</button>
          <label
            >强度<select v-model="pace.intensity">
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select></label
          ></template
        >
        <div>
          <button class="primary" :disabled="!dirty" @click="run(save)">保存规则</button
          ><button v-if="dirty || returnPace" @click="reset">放弃本次输入</button>
        </div>
        <section v-if="base && tab !== 'pacing'">
          <h3>被哪些地方引用</h3>
          <button
            v-for="r in refs"
            :key="[r.section, r.id, 'choice' in r ? r.choice : '', r.field].join('/')"
            @click="follow(r)"
          >
            {{ r.label }}
          </button>
          <p v-if="!refs.length">尚无表单引用</p>
        </section>
      </section>
    </fieldset>
    <section class="trial">
      <h3>事件试玩</h3>
      <label>从开局等待的回合数<input v-model.number="rounds" type="number" min="1" max="16" /></label
      ><button :disabled="busy" @click="play">运行事件试玩</button>
      <template v-if="trial"
        ><p v-if="!trial.occurrences.length">这些回合内没有世界事件发生。</p>
        <p v-for="o in trial.occurrences" :key="o.seq + '-' + o.id">
          {{ o.id }} · 观察者 {{ o.witnesses.map(name).join('、') || '无' }} · 获得唤醒机会
          {{ o.wakeRecipients.map(name).join('、') || '无' }}
        </p>
        <div v-for="t in trial.timeline" :key="t.round">
          <p v-for="(l, i) in t.lines" :key="i">第 {{ t.round }} 回合 · {{ l.text }}</p>
        </div></template
      >
    </section>
  </div>
</template>
<style scoped>
.rule-desk {
  padding: 22px 26px;
  color: #243e35;
  min-width: 0;
}
.event-flow {
  margin: 0 0 16px;
  padding: 10px 14px;
  border-left: 3px solid #739482;
  background: #edf2eb;
}
.event-flow ul {
  margin: 6px 0 0;
  padding-left: 22px;
}
.rule-desk header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  flex-wrap: wrap;
}
.rule-desk h2 {
  margin: 0;
}
.rule-desk button {
  padding: 7px 12px;
  margin: 3px;
  border: 1px solid #acbcb0;
  border-radius: 4px;
  background: #fff;
  color: inherit;
  cursor: pointer;
}
.rule-desk button[aria-pressed='true'],
.rule-desk .primary {
  background: #285344;
  color: white;
}
.rule-desk button:disabled {
  opacity: 0.55;
  cursor: default;
}
.rule-desk fieldset {
  border: 0;
  border-top: 1px solid #cad3cc;
  padding: 0;
  display: grid;
  grid-template-columns: minmax(140px, 32%) 1fr;
  margin: 17px 0;
}
.index,
.detail {
  padding: 14px;
  min-width: 0;
}
.index {
  border-right: 1px solid #cad3cc;
}
.entry {
  display: block;
  width: 100%;
  text-align: left;
}
.entry small {
  display: block;
  overflow-wrap: anywhere;
}
.detail {
  max-width: 680px;
}
.detail h3,
.trial h3 {
  margin: 6px 0 12px;
}
.rule-desk :deep(label) {
  display: grid;
  gap: 4px;
  margin: 9px 0;
  font-size: 14px;
}
.rule-desk :deep(input:not([type='checkbox'])),
.rule-desk :deep(select),
.rule-desk :deep(textarea) {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid #a9b8af;
  border-radius: 4px;
  background: white;
  color: #203a30;
  font: inherit;
  padding: 7px;
}
.rule-desk [role='alert'] {
  color: #9f3028;
}
.trial {
  border-top: 1px solid #c3cec6;
  padding-top: 12px;
}
.trial input {
  max-width: 100px;
}
@media (max-width: 760px) {
  .rule-desk fieldset {
    grid-template-columns: 1fr;
  }
  .index {
    border-right: 0;
  }
}
</style>
