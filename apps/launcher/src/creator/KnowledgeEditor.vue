<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { knowledgeEquality, knowledgeWhen, type Scalar } from '@perspectra/world-pack/editor-fields'
import type { KnowledgeRow, knowledgeBook } from '../../../host/src/editor/knowledge.ts'
import type { playKnowledge } from '../../../host/src/editor/knowledge-play.ts'
import { editorRequest } from './editor-api.ts'
import ScalarField from './ScalarField.vue'
import KnowledgeConditions from './KnowledgeConditions.vue'
import {
  knowledgeField,
  knowledgeTermError,
  knowledgeSchema,
  readKnowledgeCondition,
  type KnowledgeCondition,
} from '@perspectra/world-pack/editor-knowledge'
import type { knowledgeFields } from '../../../host/src/editor/knowledge-fields.ts'

const props = defineProps<{ initialId: string | undefined }>()
type Book = ReturnType<typeof knowledgeBook>
type Saved = Pick<Book, 'rows' | 'maximumCharacters'>
const book = ref<Book>(),
  row = ref<KnowledgeRow>(),
  base = ref<KnowledgeRow | null>(null)
const search = ref(''),
  readerFilter = ref(''),
  budget = ref(8000),
  busy = ref(false),
  error = ref(''),
  notice = ref('')
const mode = ref(''),
  advanced = ref(''),
  value = ref<Scalar>(false),
  keywords = ref(''),
  baseline = ref('')
const catalog = ref<Awaited<ReturnType<typeof knowledgeFields>>>(),
  group = ref<KnowledgeCondition>({ match: 'all', terms: [] })
const line = ref(''),
  trialKey = ref(''),
  first = ref<Scalar>(true),
  second = ref<Scalar>(false)
const report = ref<Awaited<ReturnType<typeof playKnowledge>>>()
const conflict = ref<{ field: string; current: KnowledgeRow | number | null; proposed: KnowledgeRow | number }>()
const copy = <T,>(x: T): T => JSON.parse(JSON.stringify(x))
const title = (r: KnowledgeRow) =>
  r.text
    .split(/\r?\n/)
    .find(s => s.trim())
    ?.replace(/^#+\s*/, '')
    .slice(0, 50) || r.documentId
const variables = computed(() => book.value?.candidates.variables ?? [])
const readers = computed(() => book.value?.candidates.readers ?? [])
const condition = computed(() => variables.value.find(v => mode.value === 'var:' + v.key))
const trialVar = computed(() => variables.value.find(v => v.key === trialKey.value))
const rows = computed(
  () =>
    book.value?.rows.filter(
      r =>
        (r.documentId + ' ' + r.text).toLowerCase().includes(search.value.trim().toLowerCase()) &&
        (!readerFilter.value || r.audience === 'public' || r.characterIds.includes(readerFilter.value)),
    ) ?? [],
)
const display = (v: Scalar | null) => (v === true ? '是' : v === false ? '否' : String(v ?? '默认'))
const audience = computed(() =>
  row.value?.audience === 'public'
    ? '所有角色'
    : readers.value
        .filter(r => row.value?.characterIds.includes(r.id))
        .map(r => r.name)
        .join('、') || '待选读者',
)
const signature = computed(() =>
  JSON.stringify([row.value, mode.value, value.value, advanced.value, keywords.value, group.value]),
)
const dirty = computed(() => !!row.value && signature.value !== baseline.value)
watch(
  [signature, line, trialKey, first, second, budget],
  () => {
    report.value = undefined
  },
  { flush: 'sync' },
)
function setTrial(key: string) {
  trialKey.value = key
  const v = trialVar.value
  if (!v) return
  first.value = v.initial
  second.value =
    v.options?.find(s => s !== v.initial) ??
    (typeof v.initial === 'boolean'
      ? !v.initial
      : typeof v.initial === 'number'
        ? v.initial === Number.MAX_SAFE_INTEGER
          ? v.initial - 1
          : v.initial + 1
        : '')
}
function pick(selected?: KnowledgeRow, fresh = false) {
  const item =
    selected ??
    (fresh
      ? ({
          documentId: 'document:entry-' + crypto.randomUUID().slice(0, 8),
          text: '',
          usage: 'world_context',
          audience: 'public',
          characterIds: [],
          delivery: { keywords: [], constant: true, priority: 0 },
        } as KnowledgeRow)
      : undefined)
  base.value = selected ? copy(selected) : null
  row.value = item ? copy(item) : undefined
  const schema = item?.delivery?.when,
    equality = knowledgeEquality(schema)
  const parsed = readKnowledgeCondition(schema)
  const editable = parsed && canEdit(parsed)
  group.value = editable ? parsed : { match: 'all', terms: [] }
  mode.value = schema
    ? editable && equality && variables.value.some(v => v.key === equality.key)
      ? 'var:' + equality.key
      : editable
        ? 'group'
        : 'advanced'
    : ''
  value.value = equality?.value ?? false
  advanced.value = schema ? JSON.stringify(schema, null, 2) : '{"type":"object"}'
  keywords.value = item?.delivery?.keywords.join('\n') ?? ''
  baseline.value = signature.value
  setTrial(condition.value?.key ?? '')
  line.value = item?.delivery?.keywords[0] ?? ''
  report.value = undefined
  conflict.value = undefined
}
async function refresh(id?: string) {
  const [b, fields] = await Promise.all([
    editorRequest<Book>('knowledge'),
    editorRequest<Awaited<ReturnType<typeof knowledgeFields>>>('knowledge-fields'),
  ])
  book.value = b
  catalog.value = fields
  budget.value = book.value.maximumCharacters
  pick(id ? book.value.rows.find(r => r.documentId === id) : book.value.rows[0])
}
async function run(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function request(operation: string, body: Record<string, unknown>) {
  try {
    return await editorRequest<Saved>(operation, body)
  } catch (e) {
    const err = e as { status?: number; details?: typeof conflict.value }
    if (err.status === 409 && err.details) {
      conflict.value = err.details
    }
    throw e
  }
}
function proposed() {
  const r = copy(row.value!)
  if (r.delivery) {
    if (keywords.value !== r.delivery.keywords.join('\n'))
      r.delivery.keywords = keywords.value
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
    if (mode.value === 'group') r.delivery.when = knowledgeSchema(group.value)
    else if (mode.value === 'advanced') r.delivery.when = JSON.parse(advanced.value)
    else if (condition.value) r.delivery.when = knowledgeWhen(condition.value.key, value.value)
    else delete r.delivery.when
  }
  return r
}
async function save() {
  if (!book.value) return
  if (conflict.value) throw new Error('请先核对并发修改')
  if (budget.value !== book.value.maximumCharacters) {
    const out = await request('knowledge-budget', {
      base: book.value.maximumCharacters,
      maximumCharacters: budget.value,
    })
    book.value.maximumCharacters = out.maximumCharacters
    notice.value = '已保存每轮字符上限'
  }
  if (!dirty.value) return
  const next = proposed(),
    out = await request('knowledge-save', {
      base: base.value,
      row: next,
      ...(next.delivery &&
      mode.value === 'group' &&
      JSON.stringify(next.delivery.when) !== JSON.stringify(base.value?.delivery?.when)
        ? { condition: group.value }
        : {}),
    })
  book.value.rows = out.rows
  const utterance = line.value,
    key = trialKey.value,
    a = first.value,
    b = second.value
  pick(out.rows.find(r => r.documentId === next.documentId))
  line.value = utterance
  trialKey.value = key
  first.value = a
  second.value = b
  notice.value = '知识条目已保存'
}
async function flush() {
  if (busy.value) throw new Error('知识库正在处理，请稍后再切换')
  await save()
}
defineExpose({ flush, reload: () => run(() => refresh(row.value?.documentId)) })
function select(id?: string) {
  void run(async () => {
    await save()
    await refresh(id)
    if (!id) pick(undefined, true)
  })
}
function toggle(enabled: boolean) {
  if (!row.value) return
  row.value.delivery = enabled ? copy(base.value?.delivery ?? { constant: true, priority: 0, keywords: [] }) : null
}
async function play() {
  await save()
  if (!base.value) return
  report.value = await editorRequest('knowledge-play', {
    documentId: base.value.documentId,
    expected: base.value,
    text: line.value,
    ...(trialKey.value ? { variable: trialKey.value, values: [first.value, second.value] } : {}),
  })
}
function resolveConflict(keep: boolean) {
  const c = conflict.value
  if (!c || !book.value) return
  if (c.current === null) {
    if (keep) {
      const draft = copy(c.proposed as KnowledgeRow)
      pick(undefined, true)
      const empty = baseline.value
      pick(draft)
      base.value = null
      baseline.value = empty
    } else pick()
  } else if (typeof c.current === 'number') {
    book.value.maximumCharacters = c.current
    if (!keep) budget.value = c.current
  } else {
    const current = c.current,
      proposed = c.proposed as KnowledgeRow
    if (!book.value.rows.some(r => r.documentId === current.documentId)) book.value.rows.push(current)
    else book.value.rows = book.value.rows.map(r => (r.documentId === current.documentId ? current : r))
    let resolved = copy(proposed)
    if (!keep) {
      if (c.field === current.documentId) resolved = copy(current)
      else
        for (const field of c.field.slice(current.documentId.length + 1).split(', ')) {
          const [group, key] = field.split('.')
          const from = group === 'delivery' && key ? current.delivery : current
          const to = group === 'delivery' && key ? resolved.delivery : resolved
          if (!from || !to) continue
          const property = key ?? group!
          if (Object.hasOwn(from, property)) Object.assign(to, { [property]: Reflect.get(from, property) })
          else Reflect.deleteProperty(to, property)
        }
    }
    pick(current)
    const saved = baseline.value
    pick(resolved)
    base.value = copy(current)
    baseline.value = saved
  }
  conflict.value = undefined
  error.value = ''
  notice.value = keep ? '请核对条目后保存' : '已采用已保存值'
}
function focusField(field: string) {
  document.getElementById('knowledge-' + field)?.focus()
}
function canEdit(condition: KnowledgeCondition) {
  const book = catalog.value
  return !!book && condition.terms.every(t => !knowledgeTermError(book.fields, book.actors, t))
}
function setMode(next: string) {
  if (next === 'advanced' && mode.value !== 'advanced') {
    try {
      advanced.value = JSON.stringify(proposed().delivery?.when ?? { type: 'object' }, null, 2)
    } catch {
      /* Keep the existing schema while the form is incomplete. */
    }
  }
  if (next === 'group') {
    let raw: unknown = condition.value ? knowledgeWhen(condition.value.key, value.value) : undefined
    if (mode.value === 'advanced') {
      try {
        raw = JSON.parse(advanced.value)
      } catch {
        /* Start from the last editable condition. */
      }
    }
    const read = readKnowledgeCondition(raw)
    if (read && canEdit(read)) group.value = { ...read, match: read.match === 'one' ? 'all' : read.match }
    else if (!group.value.terms.length)
      group.value = {
        match: 'all',
        terms: [{ path: ['characterId'], comparison: 'eq', value: catalog.value?.actors[0]?.value ?? '' }],
      }
  }
  mode.value = next
  if (condition.value) value.value = condition.value.initial
}
onMounted(() => void run(() => refresh(props.initialId)))
</script>
<template>
  <section class="knowledge">
    <header>
      <h2>知识库</h2>
      <button :disabled="busy" @click="select()">新建条目</button>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="busy || notice" role="status">{{ busy ? '正在处理…' : notice }}</p>
    <div v-if="conflict" class="conflict">
      <strong>并发修改 · {{ conflict.field }}</strong>
      <details>
        <summary>对照已保存值与我的修改</summary>
        <pre>{{ JSON.stringify(conflict.current, null, 2) }}</pre>
        <pre>{{ JSON.stringify(conflict.proposed, null, 2) }}</pre>
      </details>
      <button @click="resolveConflict(false)">采用已保存值</button
      ><button @click="resolveConflict(true)">带入我的版本并核对</button>
    </div>
    <fieldset v-if="book" :disabled="busy">
      <aside>
        <input v-model="search" aria-label="查找知识" type="search" placeholder="查正文或 ID" />
        <select v-model="readerFilter" aria-label="按读者筛选">
          <option value="">全部读者</option>
          <option v-for="r in readers" :key="r.id" :value="r.id">{{ r.name }} · {{ r.id }}</option>
        </select>
        <button
          v-for="r in rows"
          :key="r.documentId"
          class="entry"
          :aria-pressed="row?.documentId === r.documentId"
          @click="select(r.documentId)"
        >
          <b>{{ title(r) }}</b
          ><small>{{ r.documentId }}</small>
        </button>
        <p v-if="!rows.length">没有匹配的条目。</p>
        <label>每轮字符上限<input type="number" min="100" max="65536" v-model.number="budget" /></label
        ><button v-if="budget !== book.maximumCharacters" @click="run(save)">保存上限</button>
      </aside>
      <article v-if="row">
        <h3>{{ base ? title(base) : '新建知识条目' }}</h3>
        <label>条目 ID · 必填<input v-model="row.documentId" :readonly="!!base" /></label>
        <div class="pair">
          <label
            >用途 · 必填<select
              v-model="row.usage"
              @change="row.usage === 'portrayal' && (row.audience = 'character_private')"
            >
              <option value="world_context">世界设定</option>
              <option value="portrayal">角色塑造</option>
            </select></label
          >
          <label
            >读者范围 · 必填<select
              id="knowledge-readers"
              v-model="row.audience"
              @change="row.audience === 'public' && (row.characterIds = [])"
            >
              <option value="public" :disabled="row.usage === 'portrayal'">所有角色</option>
              <option value="character_private">指定角色</option>
            </select></label
          >
        </div>
        <label v-if="row.audience === 'character_private'"
          >指定读者 · 至少一人<select id="knowledge-selected" multiple v-model="row.characterIds">
            <option v-for="r in readers" :key="r.id" :value="r.id">{{ r.name }} · {{ r.id }}</option>
          </select></label
        >
        <label>正文 · 必填<textarea v-model="row.text" rows="5" placeholder="写下角色有机会知道的设定" /></label>
        <label class="check"
          ><input
            type="checkbox"
            :checked="!!row.delivery"
            @change="toggle(($event.target as HTMLInputElement).checked)"
          />参与世界书投放</label
        >
        <template v-if="row.delivery">
          <div class="pair">
            <label
              >触发方式<select id="knowledge-trigger" v-model="row.delivery.constant">
                <option :value="true">常驻</option>
                <option :value="false">命中任一关键词</option>
              </select></label
            >
            <label
              >优先级 · 必填<input
                type="number"
                step="1"
                id="knowledge-priority"
                v-model.number="row.delivery.priority"
            /></label>
          </div>
          <label
            >关键词 · {{ row.delivery.constant ? '选填' : '至少一个，每行一个'
            }}<textarea rows="2" v-model="keywords" />
          </label>
          <label
            >投放条件 · 选填<select
              id="knowledge-condition"
              :value="mode"
              @change="setMode(($event.target as HTMLSelectElement).value)"
            >
              <option value="">无条件</option>
              <option v-for="v in variables" :key="v.key" :value="'var:' + v.key">
                {{ v.label }} · {{ v.key }}{{ v.readable ? '' : '（角色获知后）' }}
              </option>
              <option value="group">组合条件 · 按已有字段选择</option>
              <option value="advanced">高级 JSON Schema</option>
            </select></label
          >
          <label v-if="condition">角色已知值等于<ScalarField :definition="condition" v-model="value" /></label>
          <KnowledgeConditions
            v-if="mode === 'group' && catalog"
            :group="group"
            :book="catalog"
            @change="v => (group = v)"
          />
          <label v-if="mode === 'advanced'"
            >条件 JSON Schema<textarea v-model="advanced" rows="6" spellcheck="false" />
          </label>
        </template>
        <section class="flow" aria-label="投放流程">
          <h4>投放流程</h4>
          <ol v-if="row.delivery">
            <li>
              <button @click="focusField(row.audience === 'public' ? 'readers' : 'selected')">{{ audience }}</button>
            </li>
            <li>
              <button @click="focusField('condition')">
                {{
                  condition
                    ? condition.label + ' = ' + display(value)
                    : mode === 'group'
                      ? (group.match === 'any' ? '任一满足' : '全部满足') +
                        ' · ' +
                        group.terms
                          .map(t => knowledgeField(catalog?.fields ?? [], t.path, t.activity)?.label)
                          .join('、')
                      : mode === 'advanced'
                        ? '高级条件'
                        : '无条件'
                }}
              </button>
            </li>
            <li>
              <button @click="focusField('trigger')">{{ row.delivery.constant ? '常驻' : '命中关键词' }}</button>
            </li>
            <li>
              <button @click="focusField('priority')">
                优先级 {{ row.delivery.priority }} · 上限 {{ budget }} 字符
              </button>
            </li>
          </ol>
          <p v-else>这条文档尚未加入世界书。</p>
        </section>
        <div class="actions">
          <button class="primary" :disabled="!dirty" @click="run(save)">保存条目</button
          ><button v-if="dirty" @click="run(() => refresh(base?.documentId))">放弃本次输入</button>
        </div>
        <section class="trial">
          <h3>投放对照试玩</h3>
          <label>玩家发言<input v-model="line" maxlength="2000" placeholder="备用灯在哪里？" /></label>
          <label
            >对照变量<select :value="trialKey" @change="setTrial(($event.target as HTMLSelectElement).value)">
              <option value="">只用默认开局</option>
              <option v-for="v in variables" :key="v.key" :value="v.key">{{ v.label }} · {{ v.key }}</option>
            </select></label
          >
          <div v-if="trialVar" class="pair">
            <label>开局 A<ScalarField :definition="trialVar" v-model="first" /></label
            ><label>开局 B<ScalarField :definition="trialVar" v-model="second" /></label>
          </div>
          <button @click="run(play)" :disabled="!line.trim() || (!base && !dirty) || (!!trialVar && first === second)">
            核对模型请求
          </button>
          <table v-if="report">
            <caption>
              同一句发言 ·
              {{
                report.text
              }}
            </caption>
            <thead>
              <tr>
                <th>起点</th>
                <th>角色</th>
                <th>本轮请求中的条目</th>
              </tr>
            </thead>
            <tbody v-for="(t, i) in report.trials" :key="i">
              <tr v-for="r in t.actors" :key="r.id">
                <td>{{ report.variable ? report.variable + ' = ' + display(t.value) : '默认开局' }}</td>
                <td>
                  {{ r.name }}<small>{{ r.id }}</small>
                </td>
                <td>{{ r.requests.map(q => (q.received ? '收到正文' : '未收到正文')).join('、') || '未发起请求' }}</td>
              </tr>
              <tr v-if="!t.actors.length">
                <td colspan="3">本轮没有角色模型请求</td>
              </tr>
            </tbody>
          </table>
        </section>
      </article>
    </fieldset>
  </section>
</template>
<style scoped>
.knowledge {
  color: #243e35;
  padding: 22px 26px;
  min-width: 0;
}
.knowledge header,
.actions,
.pair {
  display: flex;
  align-items: center;
  gap: 12px;
}
.knowledge header {
  justify-content: space-between;
}
.knowledge h2,
.knowledge h3 {
  margin: 0 0 10px;
}
.knowledge h4 {
  margin: 0;
}
.knowledge fieldset {
  display: grid;
  grid-template-columns: minmax(160px, 30%) minmax(0, 1fr);
  border: 0;
  border-top: 1px solid #cad3cc;
  padding: 0;
  margin: 14px 0;
  min-width: 0;
}
.knowledge aside {
  padding: 16px 15px 0 0;
  border-right: 1px solid #cad3cc;
}
.knowledge article {
  padding: 16px;
  max-width: 760px;
  min-width: 0;
}
.knowledge small {
  display: block;
  overflow-wrap: anywhere;
}
.knowledge label {
  display: grid;
  gap: 4px;
  margin: 10px 0;
  font-size: 14px;
}
.pair > label {
  flex: 1;
  min-width: 0;
}
.knowledge :deep(input:not([type='checkbox'])),
.knowledge :deep(select),
.knowledge textarea {
  box-sizing: border-box;
  width: 100%;
  font: inherit;
  color: inherit;
  padding: 7px;
  border: 1px solid #a9b8af;
  border-radius: 4px;
  background: white;
}
.knowledge aside select {
  margin: 6px 0;
}
.knowledge button {
  cursor: pointer;
  font: inherit;
  color: inherit;
  background: white;
  border: 1px solid #acbcb0;
  border-radius: 4px;
  padding: 6px 10px;
}
.knowledge button:disabled {
  opacity: 0.55;
  cursor: default;
}
.knowledge .primary,
.entry[aria-pressed='true'] {
  background: #285344;
  color: #fff;
}
.entry {
  width: 100%;
  display: block;
  text-align: left;
  margin: 4px 0;
}
.knowledge .check {
  display: flex;
  align-items: center;
  gap: 8px;
}
.flow {
  background: #edf2eb;
  border-left: 3px solid #739482;
  padding: 10px 14px;
  margin: 14px 0;
}
.flow ol {
  display: flex;
  flex-wrap: wrap;
  list-style: none;
  gap: 6px;
  padding: 0;
  margin: 6px 0;
}
.flow li + li:before {
  content: '→';
  margin-right: 6px;
}
.knowledge details,
.trial {
  margin-top: 18px;
  border-top: 1px solid #cad3cc;
  padding-top: 12px;
}
.knowledge summary {
  cursor: pointer;
}
.knowledge table {
  border-collapse: collapse;
  text-align: left;
  width: 100%;
  font-size: 14px;
  margin-top: 10px;
}
.knowledge td,
.knowledge th {
  border-bottom: 1px solid #cad3cc;
  padding: 6px;
}
.knowledge caption {
  text-align: left;
}
.knowledge [role='alert'] {
  color: #93372b;
}
.conflict pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 760px) {
  .knowledge {
    padding: 14px;
  }
  .knowledge fieldset {
    grid-template-columns: 1fr;
  }
  .knowledge aside {
    border: 0;
  }
  .knowledge article {
    padding: 14px 0;
  }
}
</style>
