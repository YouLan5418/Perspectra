<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import ScalarField from './ScalarField.vue'
import { editorRequest } from './editor-api.ts'
import type { encounterTables, previewTable } from '../../../host/src/editor/encounter-tables.ts'
import type { EncounterTable, TableCondition, TableRow } from '../../../host/src/runtime/encounter-tables.ts'
type Book = ReturnType<typeof encounterTables>
type Variable = Book['catalog']['variables'][number]
const props = defineProps<{ initial?: string | undefined; field?: string | undefined }>()
const panel = ref<HTMLElement>()
const book = ref<Book>(),
  tables = ref<EncounterTable[]>([]),
  selected = ref(0),
  busy = ref(false),
  message = ref(''),
  error = ref('')
const table = computed(() => tables.value[selected.value])
const vars = computed(() => book.value?.catalog.variables ?? [])
const operators = { eq: '等于', ne: '不等于', lt: '小于', lte: '小于或等于', gt: '大于', gte: '大于或等于' }
const previewLocation = ref(''),
  values = ref<Record<string, string | boolean | number>>({}),
  counts = ref<Record<string, number>>({})
const result = ref<ReturnType<typeof previewTable>>()
const witnessed = ref<string[]>([])
const dirty = computed(() => !!book.value && JSON.stringify(tables.value) !== JSON.stringify(book.value.base.tables))
const previewEvents = computed(
  () => book.value?.catalog.events.filter(e => table.value?.rows.some(r => r.event === e.id)) ?? [],
)
const previewVars = computed(() =>
  vars.value.filter(
    v => v.key === table.value?.clockKey || table.value?.rows.some(r => r.conditions?.some(c => c.key === v.key)),
  ),
)
watch(
  [tables, selected, previewLocation, values, counts, witnessed],
  () => {
    result.value = undefined
    message.value = ''
  },
  { deep: true, flush: 'sync' },
)
watch(selected, () => {
  counts.value = {}
})
function load(next: Book) {
  book.value = next
  tables.value = JSON.parse(JSON.stringify(next.base.tables))
  selected.value = Math.min(selected.value, Math.max(0, tables.value.length - 1))
}
function nextKey(rows: { key: string }[], prefix: string) {
  let i = 1
  while (rows.some(r => r.key === prefix + i)) i++
  return prefix + i
}
function newRow(rows: TableRow[]): TableRow {
  return { key: nextKey(rows, 'row-'), title: '新遭遇', kind: 'encounter' }
}
function addTable() {
  tables.value.push({ key: nextKey(tables.value, 'list-'), title: '新候选表', rows: [newRow([])] })
  selected.value = tables.value.length - 1
}
function removeTable() {
  tables.value.splice(selected.value, 1)
  selected.value = Math.max(0, selected.value - 1)
  counts.value = {}
}
async function work(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function save() {
  if (!book.value || !dirty.value) return
  load(await editorRequest<Book>('tables-save', { base: book.value.base, tables: tables.value }))
  message.value = '候选表已保存'
}
async function preview() {
  const scenario = Object.fromEntries(previewVars.value.map(v => [v.key, values.value[v.key] ?? defaultValue(v)]))
  const used = Object.fromEntries(
    (table.value?.rows ?? [])
      .filter(r => r.limit && typeof counts.value[r.key] === 'number')
      .map(r => [r.key, counts.value[r.key]]),
  )
  result.value = await editorRequest<ReturnType<typeof previewTable>>('tables-preview', {
    table: table.value,
    location: previewLocation.value || null,
    values: scenario,
    counts: used,
    events: witnessed.value.filter(id => previewEvents.value.some(e => e.id === id)),
  })
}
function numberField(row: TableRow, key: 'reward' | 'limit' | 'weight' | 'duration', event: Event) {
  const value = (event.target as HTMLInputElement).value
  if (value === '') delete row[key]
  else row[key] = Number(value)
}
function variable(key: string) {
  return vars.value.find(v => v.key === key)
}
function defaultValue(v: Variable) {
  return v.options?.[0] ?? (v.type === 'boolean' ? false : v.type === 'number' ? 0 : '')
}
function selectCondition(c: TableCondition, key: string) {
  const v = variable(key)
  if (v) Object.assign(c, { key, op: 'eq', value: defaultValue(v) })
}
function addCondition(row: TableRow) {
  const v = vars.value[0]
  if (!v) return
  row.conditions ??= []
  row.conditions.push({ key: v.key, op: 'eq', value: defaultValue(v) })
}
onMounted(async () => {
  await work(async () => load(await editorRequest<Book>('tables')))
  if (!props.initial) return
  selected.value = Math.max(
    0,
    tables.value.findIndex(t => t.key === props.initial),
  )
  await nextTick()
  const target = Array.from(panel.value?.querySelectorAll<HTMLElement>('[data-field]') ?? []).find(
    el => el.dataset.field === props.field,
  )
  const details = target?.closest('details')
  if (details) details.open = true
  target?.focus()
})
defineExpose({
  async flush() {
    if (busy.value) throw Error('候选表仍在处理')
    await save()
  },
})
</script>
<template>
  <section ref="panel" class="tables">
    <header>
      <h2>遭遇、委托与结算表</h2>
      <button :disabled="busy || !book" @click="addTable">新建表</button
      ><button :disabled="busy || !dirty" @click="work(save)">保存</button>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <fieldset v-if="book" :disabled="busy">
      <p v-if="!table">新建一张表，添加玩家可能遇见的事件或接到的委托。</p>
      <template v-else>
        <div class="line">
          <label
            >当前表<select v-model="selected">
              <option v-for="(t, i) in tables" :key="i" :value="i">{{ t.title }}</option>
            </select></label
          >
          <label>表名<input v-model="table.title" /></label><label>标识<input v-model="table.key" /></label
          ><button @click="removeTable">移除表</button>
        </div>
        <div class="line">
          <label
            >期限使用的计时变量<select v-model="table.clockKey" data-field="clockKey">
              <option :value="undefined">未使用</option>
              <option v-for="v in vars.filter(v => v.type === 'number')" :key="v.key" :value="v.key">
                {{ v.label }}
              </option>
            </select></label
          >
        </div>
        <h3>候选</h3>
        <div v-for="(r, i) in table.rows" :key="i" class="row">
          <div class="line">
            <input v-model="r.title" aria-label="候选名称" />
            <select
              v-model="r.kind"
              aria-label="候选类型"
              @change="r.kind === 'encounter' && (delete r.duration, delete r.completeEvent)"
            >
              <option value="encounter">遭遇</option>
              <option value="quest">委托</option>
            </select>
            <label
              >抽取权重<input
                type="number"
                min="1"
                :value="r.weight"
                placeholder="1"
                @input="numberField(r, 'weight', $event)"
            /></label>
            <button @click="table.rows.splice(i, 1)">移除候选</button>
          </div>
          <details>
            <summary>出现条件、结算与次数</summary>
            <div class="line">
              <label>标识<input v-model="r.key" /></label>
              <label
                >地点<select v-model="r.location">
                  <option :value="undefined">任意地点</option>
                  <option v-for="l in book.catalog.locations" :key="l.id" :value="l.id">{{ l.name }}</option>
                </select></label
              >
              <label
                >出现所需事件<select v-model="r.event" :data-field="r.key + '/event'">
                  <option :value="undefined">不限</option>
                  <option v-for="e in book.catalog.events" :key="e.id" :value="e.id">
                    {{ e.label }} · {{ e.id }}{{ e.paced ? ' · 节拍器' : '' }}
                  </option>
                </select></label
              >
              <label
                >最多出现次数<input
                  type="number"
                  min="1"
                  :value="r.limit"
                  placeholder="不限"
                  @input="numberField(r, 'limit', $event)"
              /></label>
            </div>
            <div v-for="(c, j) in r.conditions" :key="j" class="line">
              <label
                >世界变量<select
                  :value="c.key"
                  :data-field="r.key + '/condition/' + j"
                  @change="selectCondition(c, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="v in vars" :key="v.key" :value="v.key">{{ v.label }}</option>
                </select></label
              >
              <label
                >比较方式<select v-model="c.op">
                  <template v-for="(label, op) in operators" :key="op"
                    ><option v-if="op === 'eq' || op === 'ne' || variable(c.key)?.type === 'number'" :value="op">
                      {{ label }}
                    </option></template
                  >
                </select></label
              >
              <label v-if="variable(c.key)"
                >条件值<ScalarField :definition="variable(c.key)!" v-model="c.value"
              /></label>
              <button @click="r.conditions!.splice(j, 1)">移除条件</button>
            </div>
            <button :disabled="!vars.length" @click="addCondition(r)">添加变量条件</button>
            <p v-if="!vars.length">可在「变量与世界事件」定义公开变量，再回来添加条件。</p>
            <label>玩家看到的描述<textarea v-model="r.text" rows="2"></textarea></label>
            <div class="line">
              <label
                >奖励变量<select
                  v-model="r.rewardKey"
                  :data-field="r.key + '/rewardKey'"
                  @change="!r.rewardKey && delete r.reward"
                >
                  <option :value="undefined">无奖励</option>
                  <option v-for="v in vars.filter(v => v.type === 'number' && v.writable)" :key="v.key" :value="v.key">
                    {{ v.label }}
                  </option>
                </select></label
              >
              <label v-if="r.rewardKey"
                >增加数量<input type="number" min="1" :value="r.reward" @input="numberField(r, 'reward', $event)"
              /></label>
              <template v-if="r.kind === 'quest'"
                ><label
                  >接取后可经过的周期数<input
                    type="number"
                    min="1"
                    :disabled="!table.clockKey"
                    :value="r.duration"
                    placeholder="不限"
                    @input="numberField(r, 'duration', $event)"
                /></label>
                <label
                  >交付所需事件<select v-model="r.completeEvent" :data-field="r.key + '/completeEvent'">
                    <option :value="undefined">不限</option>
                    <option v-for="e in book.catalog.events" :key="e.id" :value="e.id">
                      {{ e.label }} · {{ e.id }}{{ e.paced ? ' · 节拍器' : '' }}
                    </option>
                  </select></label
                ></template
              >
            </div>
          </details>
        </div>
        <button @click="table.rows.push(newRow(table.rows))">新增候选</button>
        <h3>此时此地会出现什么</h3>
        <div class="line">
          <label
            >预览地点<select v-model="previewLocation">
              <option value="">未指定</option>
              <option v-for="l in book.catalog.locations" :key="l.id" :value="l.id">{{ l.name }}</option>
            </select></label
          >
          <label v-for="v in previewVars" :key="v.key"
            >{{ v.label
            }}<ScalarField
              :definition="v"
              :model-value="values[v.key] ?? defaultValue(v)"
              @update:model-value="values[v.key] = $event"
          /></label>
          <label v-for="e in previewEvents" :key="e.id"
            ><span
              ><input type="checkbox" v-model="witnessed" :value="e.id" /> 已见证 {{ e.label }} · {{ e.id }}</span
            ></label
          >
          <label v-for="r in table.rows.filter(r => r.limit)" :key="r.key"
            >{{ r.title }}已出现<input type="number" min="0" v-model.number="counts[r.key]" placeholder="0"
          /></label>
          <button @click="work(preview)">预览候选</button>
        </div>
        <table v-if="result">
          <thead>
            <tr>
              <th>候选</th>
              <th>抽中概率</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in result.rows" :key="r.key">
              <td>{{ r.title }}</td>
              <td>{{ r.reasons.length ? '0' : r.weight + ' / ' + result.total }}</td>
              <td>{{ r.reasons.join('；') || r.matches.join('；') || '无附加条件' }}</td>
            </tr>
          </tbody>
        </table>
      </template>
    </fieldset>
  </section>
</template>
<style scoped>
.tables {
  padding: 18px 24px;
  color: #252525;
  max-width: 1150px;
}
header,
.line {
  display: flex;
  align-items: end;
  gap: 12px;
  flex-wrap: wrap;
}
header {
  align-items: center;
}
h2 {
  margin-right: auto;
}
h3 {
  margin-top: 24px;
}
.row,
fieldset {
  border: 0;
  border-top: 1px solid #ddd;
  padding: 10px 0;
}
label {
  display: grid;
  gap: 4px;
  font-size: 13px;
}
input,
select,
textarea,
button {
  font: inherit;
  padding: 5px 8px;
  max-width: 100%;
}
details {
  margin-top: 8px;
}
details .line,
details > label {
  margin: 10px 0;
}
summary,
button {
  cursor: pointer;
}
th,
td {
  text-align: left;
  padding: 7px 14px;
  border-bottom: 1px solid #ddd;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin-top: 12px;
}
[role='alert'] {
  color: #a02020;
}
</style>
