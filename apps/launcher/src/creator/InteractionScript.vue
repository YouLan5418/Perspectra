<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { editorRequest } from './editor-api.ts'
import type { interactionScript } from '../../../host/src/editor/interaction-script.ts'

type Book = ReturnType<typeof interactionScript>
const book = ref<Book>(),
  source = ref(''),
  config = ref(''),
  id = ref(''),
  label = ref('')
const operations = ref<Book['operations']>([]),
  inspected = ref(''),
  busy = ref(false),
  error = ref(''),
  message = ref(''),
  preview = ref('')
const conflict = ref(false)
const responders = ref<Record<string, string[]>>({})
const choosing = ref<string[]>([])
const missingOperations = computed(() =>
  Object.keys(responders.value).filter(id => !operations.value.some(op => op.id === id)),
)
function setMode(id: string, mode: string) {
  choosing.value = choosing.value.filter(key => key !== id)
  if (mode === 'default') delete responders.value[id]
  else {
    if (mode === 'selected') choosing.value.push(id)
    responders.value[id] = []
  }
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2)
const dirty = computed(
  () =>
    book.value &&
    (source.value !== book.value.source ||
      config.value !== pretty(book.value.base.config) ||
      pretty(responders.value) !== pretty(book.value.base.responders)),
)
watch(
  [source, config],
  () => {
    preview.value = ''
    message.value = ''
  },
  { flush: 'sync' },
)
function load(b: Book) {
  book.value = b
  source.value = b.source
  config.value = pretty(b.base.config)
  responders.value = Object.fromEntries(Object.entries(b.base.responders).map(([id, roles]) => [id, [...roles]]))
  choosing.value = Object.keys(responders.value).filter(id => responders.value[id]!.length)
  operations.value = b.operations
  inspected.value = b.source
  conflict.value = false
  error.value = b.error
}
async function reload() {
  load(await editorRequest<Book>('interaction-script'))
}
async function work(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await action()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function save(explicit = false) {
  if (!book.value) throw Error('日常交互尚未载入')
  if (conflict.value) throw Error('源包已变化，请先重新载入')
  if (choosing.value.some(id => !responders.value[id]?.length)) throw Error('请为指定回应的操作选择至少一位角色')
  if (!dirty.value && (!explicit || book.value.base.enabled)) return
  try {
    load(
      await editorRequest<Book>('interaction-script-save', {
        base: book.value.base,
        source: source.value,
        config: JSON.parse(config.value),
        responders: responders.value,
      }),
    )
    message.value = '交互脚本已保存'
  } catch (e) {
    if ((e as { status?: number }).status === 409) conflict.value = true
    throw e
  }
}
async function append() {
  const draft = await editorRequest<{ source: string; operations: Book['operations'] }>('interaction-script-draft', {
    source: source.value,
    id: id.value.trim(),
    label: label.value.trim(),
  })
  source.value = draft.source
  inspected.value = draft.source
  operations.value = draft.operations
  id.value = ''
  label.value = ''
  message.value = '已加入草稿，可编辑出现条件和执行结果'
}
async function play() {
  await save()
  const result = await editorRequest<{ url: string }>('interaction-preview')
  preview.value = result.url
}
onMounted(() => work(reload))
defineExpose({
  async flush() {
    if (busy.value) throw Error('日常交互正在处理')
    if (book.value) await save()
  },
})
</script>
<template>
  <section class="interactions">
    <header>
      <h2>日常交互</h2>
      <span v-if="book">{{ dirty ? '有未保存修改' : book.base.enabled ? '已启用包内脚本' : '尚未启用包内脚本' }}</span>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <fieldset v-if="book" :disabled="busy">
      <aside>
        <h3>脚本声明的操作</h3>
        <p v-if="source !== inspected">保存后更新操作列表。</p>
        <p v-else-if="!operations.length">当前脚本没有声明操作。</p>
        <details v-for="op in operations" :key="op.id">
          <summary>{{ op.label }}</summary>
          <code>{{ op.id }}</code>
          <p v-if="op.group || op.targetKind">{{ [op.group, op.targetKind].filter(Boolean).join(' · ') }}</p>
          <p v-if="op.whenToUse">{{ op.whenToUse }}</p>
          <label
            >玩家单独执行后
            <select
              :value="!responders[op.id] ? 'default' : choosing.includes(op.id) ? 'selected' : 'none'"
              @change="setMode(op.id, ($event.target as HTMLSelectElement).value)"
            >
              <option value="default">按场景回应</option>
              <option value="none">只给操作回执</option>
              <option value="selected" :disabled="!book.characters.length">指定可回应角色</option>
            </select>
          </label>
          <label v-for="person in choosing.includes(op.id) ? book.characters : []" :key="person.id">
            <span><input v-model="responders[op.id]" type="checkbox" :value="person.id" /> {{ person.name }}</span>
          </label>
          <details class="parameters">
            <summary>参数结构</summary>
            <pre>{{ pretty(op.parameters) }}</pre>
          </details>
        </details>
        <p v-for="unknownId in missingOperations" :key="unknownId" role="alert">
          回应配置引用了缺失的操作 {{ unknownId }} <button @click="setMode(unknownId, 'default')">移除引用</button>
        </p>
        <h3>新增交互</h3>
        <label>操作名称<input v-model="label" placeholder="倾听门外动静" /></label>
        <label>操作 ID<input v-model="id" placeholder="porch:listen" /></label>
        <button :disabled="!id.trim() || !label.trim() || conflict" @click="work(append)">加入脚本草稿</button>
      </aside>
      <article>
        <label
          >JavaScript 源码 <code>{{ book.base.path }}</code
          ><textarea v-model="source" rows="18" spellcheck="false"></textarea>
        </label>
        <details>
          <summary>包内脚本配置 · 选填</summary>
          <label>配置 JSON<textarea v-model="config" rows="4" spellcheck="false"></textarea></label>
        </details>
        <div class="actions">
          <button :disabled="conflict || (!dirty && book.base.enabled)" @click="work(() => save(true))">
            {{ book.base.enabled ? '保存交互脚本' : '保存并启用脚本' }}
          </button>
          <button v-if="dirty || conflict" @click="work(reload)">放弃草稿并重新载入</button>
          <button :disabled="conflict" @click="work(play)">试玩日常交互</button>
          <a v-if="preview" :href="preview" target="_blank" rel="noreferrer">打开试玩窗口 ↗</a>
        </div>
      </article>
    </fieldset>
  </section>
</template>
<style scoped>
.interactions {
  max-width: 1200px;
  padding: 18px 24px;
  color: #243e35;
}
header,
.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
header h2 {
  margin: 0;
  font-size: 1.35rem;
  font-weight: 650;
}
header span {
  font-size: 0.875rem;
  color: #496155;
}
fieldset {
  display: grid;
  grid-template-columns: minmax(190px, 1fr) minmax(0, 3fr);
  gap: 24px;
  border: 0;
  border-top: 1px solid #cad3cc;
  padding: 12px 0;
  margin-top: 14px;
}
aside,
article,
label {
  display: grid;
  align-content: start;
  gap: 7px;
  min-width: 0;
}
label {
  margin: 6px 0;
}
textarea,
select,
input {
  font: inherit;
  border: 1px solid #aabbb1;
  border-radius: 4px;
  background: #fff;
  padding: 7px 9px;
  min-width: 0;
}
textarea,
pre,
code {
  font-family: ui-monospace, monospace;
}
textarea {
  resize: vertical;
  line-height: 1.5;
}
pre {
  overflow: auto;
}
details {
  margin: 5px 0;
}
summary,
button {
  cursor: pointer;
}
button {
  padding: 7px 12px;
  border: 1px solid #849e90;
  border-radius: 4px;
  background: #fff;
}
.actions button:first-child:enabled {
  border-color: #22584c;
  background: #22584c;
  color: #fff;
}
button:disabled {
  cursor: default;
  color: #63776c;
  border-color: #cdd5cf;
  background: #eef1ec;
}
.actions a {
  text-decoration: underline;
}
h3 {
  margin: 9px 0;
  font-weight: 650;
}
.parameters {
  margin-left: 12px;
}
[role='alert'] {
  color: #923b2b;
}
@media (max-width: 760px) {
  fieldset {
    grid-template-columns: 1fr;
  }
}
</style>
