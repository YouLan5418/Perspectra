<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { editorRequest } from './editor-api.ts'
import type { scriptEntries, readHandActivity } from '../../../host/src/editor/adjudication-files.ts'
import type { ActivityReference } from '../../../host/src/editor/activity-references.ts'
const uses = ref<ActivityReference[]>([])
const emit = defineEmits<{ activity: [key: string, choice: string, field: string, reference: string] }>()
const props = defineProps<{ initial?: string | undefined }>()
type Book = { adjudications: ReturnType<typeof scriptEntries>; activities: string[] }
const book = ref<Book>({ adjudications: [], activities: [] }),
  selection = ref(''),
  key = ref(''),
  source = ref(''),
  base = ref<string | null>(null)
const busy = ref(false),
  error = ref(''),
  notice = ref('')
const conflict = ref<{ current: string | null }>(),
  path = ref(''),
  operations = ref<ReturnType<typeof readHandActivity>['operations']>([])
const fresh = ref(false)
const kind = computed(() => (selection.value.startsWith('activity/') ? 'activity' : 'ruling'))
const dirty = computed(() =>
  base.value !== null ? source.value !== base.value : fresh.value && (!!key.value || source.value !== template),
)
const template =
  '// @perspectra-rule {"title":"搜查消耗","type":"number","parameters":[{"key":"cost","label":"消耗","type":"number","initial":1}]}\nexport default function adjudicate(value, parameters) {\n  if (value < parameters.cost) return {rejectReason: "精力不足。"}\n  return {value: value - parameters.cost}\n}\n'
async function reload() {
  book.value = await editorRequest<Book>('scripts')
}
function reset() {
  base.value = null
  source.value = ''
  key.value = ''
  selection.value = ''
  path.value = ''
  operations.value = []
  conflict.value = undefined
  uses.value = []
  fresh.value = false
}
async function open(id: string) {
  reset()
  selection.value = id
  key.value = id.split('/')[1] ?? ''
  const row = await editorRequest<{
    source: string
    path: string
    operations?: typeof operations.value
    error?: string
  }>('script-read', { key: key.value, kind: kind.value })
  base.value = row.source
  source.value = row.source
  path.value = row.path
  operations.value = row.operations ?? []
  error.value = row.error ?? ''
  if (kind.value === 'ruling')
    uses.value = await editorRequest('activity-references', { kind: 'script', id: key.value })
}
async function save() {
  if (conflict.value) throw Error('请先处理脚本保存冲突')
  if (!dirty.value) return
  if (!key.value.trim()) throw Error('请填写脚本标识后再保存，或取消新建。')
  const id = kind.value + '/' + key.value
  try {
    await editorRequest('script-save', { kind: kind.value, key: key.value, base: base.value, source: source.value })
  } catch (e) {
    const err = e as { status?: number; details?: { current: string | null } }
    if (err.status === 409 && err.details) conflict.value = { current: err.details.current }
    throw e
  }
  await reload()
  await open(id)
  notice.value = '脚本已保存'
}
async function work(fn: () => Promise<void>) {
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
function create() {
  reset()
  fresh.value = true
  source.value = template
}
onMounted(() =>
  work(async () => {
    await reload()
    const first =
      props.initial ??
      (book.value.adjudications[0]
        ? 'ruling/' + book.value.adjudications[0].key
        : book.value.activities[0]
          ? 'activity/' + book.value.activities[0]
          : '')
    if (first) await open(first)
  }),
)
defineExpose({
  async flush() {
    if (busy.value) throw Error('脚本正在处理')
    await save()
  },
})
</script>
<template>
  <section class="scripts">
    <h2>规则脚本</h2>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice || busy" role="status">{{ busy ? '正在处理…' : notice }}</p>
    <details v-if="uses.length">
      <summary>活动引用（{{ uses.length }}）</summary>
      <button
        v-for="r in uses"
        :key="r.activity + '/' + r.choice"
        @click="emit('activity', r.activity, r.choice, r.field, 'script/' + r.id)"
      >
        {{ r.source }} › {{ r.fieldLabel }}
      </button>
    </details>
    <fieldset :disabled="busy">
      <aside>
        <h3>可复用裁定</h3>
        <button
          v-for="s in book.adjudications"
          :key="s.key"
          :aria-pressed="selection === 'ruling/' + s.key"
          @click="
            work(async () => {
              await save()
              await open('ruling/' + s.key)
            })
          "
        >
          {{ s.declaration?.title ?? s.key }} · {{ s.key }}
        </button>
        <button
          @click="
            work(async () => {
              await save()
              create()
            })
          "
        >
          新建裁定脚本
        </button>
        <h3 v-if="book.activities.length">已有手写活动</h3>
        <button
          v-for="id in book.activities"
          :key="id"
          :aria-pressed="selection === 'activity/' + id"
          @click="
            work(async () => {
              await save()
              await open('activity/' + id)
            })
          "
        >
          {{ id }}
        </button>
      </aside>
      <article v-if="fresh || selection">
        <label v-if="fresh">脚本标识<input v-model="key" placeholder="search-cost" required /></label>
        <p v-else>
          <code>{{ path }}</code>
        </p>
        <details v-if="operations.length">
          <summary>操作与参数（{{ operations.length }}）</summary>
          <div v-for="o in operations" :key="o.id">
            <b>{{ o.label }}</b> · {{ o.id }}
            <pre>{{ JSON.stringify(o.schema, null, 2) }}</pre>
          </div>
        </details>
        <label>JavaScript 源码<textarea v-model="source" rows="14" spellcheck="false"></textarea></label>
        <button :disabled="!dirty || !!conflict" @click="work(save)">保存脚本</button>
        <button v-if="fresh" @click="reset">取消新建</button>
        <div v-if="conflict">
          <label>已保存的版本<textarea :value="conflict.current ?? ''" readonly></textarea></label>
          <button
            @click="
              work(async () => {
                base = conflict!.current
                if (base === null && kind === 'ruling') fresh = true
                conflict = undefined
                await save()
              })
            "
          >
            保留我的源码
          </button>
          <button
            @click="
              work(async () => {
                await open(kind + '/' + key)
              })
            "
          >
            读取已保存源码
          </button>
        </div>
      </article>
    </fieldset>
  </section>
</template>
<style scoped>
.scripts {
  max-width: 1100px;
  margin: auto;
  padding: 16px;
}
.scripts fieldset {
  display: grid;
  grid-template-columns: minmax(170px, 1fr) minmax(0, 3fr);
  gap: 24px;
  border: 0;
  padding: 0;
}
.scripts aside,
.scripts label {
  display: grid;
  gap: 6px;
  align-content: start;
}
.scripts label,
.scripts details {
  margin: 12px 0;
}
.scripts button {
  padding: 7px 10px;
}
.scripts [aria-pressed='true'] {
  font-weight: 700;
}
.scripts textarea {
  font-family: ui-monospace, monospace;
  max-width: 100%;
  resize: vertical;
}
.scripts pre {
  overflow: auto;
}
@media (max-width: 700px) {
  .scripts fieldset {
    grid-template-columns: 1fr;
  }
}
</style>
