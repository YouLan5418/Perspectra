<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { RolePreset } from '@perspectra/providers/chat/preset'
import PresetContentEditor from '../components/PresetContentEditor.vue'
import { editorRequest } from './editor-api.ts'
import type { PresetRow, PresetScope, presetBook, savePreset } from '../../../host/src/editor/presets.ts'
import type { playPresets } from '../../../host/src/editor/preset-play.ts'
const props = defineProps<{ initialKey: string | undefined }>()
type Book = ReturnType<typeof presetBook>
type Result = ReturnType<typeof savePreset>
const copy = <T,>(x: T): T => JSON.parse(JSON.stringify(x))
const key = (r: PresetRow) => r.scope + '/' + r.id
const book = ref<Book>({ rows: [], characters: [] }),
  base = ref<PresetRow | null>(null)
const fresh = (scope: PresetScope): PresetRow => ({
  scope,
  id: '',
  preset: {},
  ...(scope === 'group' ? { members: [] } : {}),
})
const row = ref<PresetRow>(fresh('pack')),
  baseline = ref(''),
  revision = ref(0)
const search = ref(''),
  memberSearch = ref(''),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  pendingDelete = ref(false)
const line = ref(''),
  assigned = ref(false),
  report = ref<Awaited<ReturnType<typeof playPresets>>>()
const conflict = ref<{
  field: string
  current: PresetRow | null
  proposed: PresetRow | null
  useCurrent: PresetRow | null
}>()
const dirty = computed(() => JSON.stringify(row.value) !== baseline.value)
const labels = { pack: '包推荐', character: '角色专属', group: '角色组' } as const
const numeric = [
  ['temperature', '温度', 0, 2],
  ['topP', 'Top P', 0, 1],
  ['frequencyPenalty', '频率惩罚', -2, 2],
  ['presencePenalty', '存在惩罚', -2, 2],
  ['maxOutputTokens', '最大输出 Token', 1, 32768],
] as const
const actorName = (id: string) => book.value.characters.find(c => c.id === id)?.name ?? id
const name = (r: PresetRow) => (r.scope === 'pack' ? '包推荐' : r.scope === 'group' ? r.id : actorName(r.id))
const rows = computed(() =>
  book.value.rows.filter(r =>
    (name(r) + ' ' + r.id + ' ' + labels[r.scope]).toLowerCase().includes(search.value.toLowerCase()),
  ),
)
const groupOf = (id: string) => book.value.rows.find(r => r.scope === 'group' && r.members?.includes(id))
const members = computed(() =>
  book.value.characters.filter(
    c =>
      row.value.members?.includes(c.id) ||
      (c.name + ' ' + c.id).toLowerCase().includes(memberSearch.value.toLowerCase()),
  ),
)
const availableCharacters = computed(() =>
  book.value.characters.filter(c => !book.value.rows.some(r => r.scope === 'character' && r.id === c.id)),
)
const eligible = computed(() =>
  base.value?.scope === 'character'
    ? book.value.characters.filter(c => c.id === base.value?.id)
    : availableCharacters.value.filter(
        c => c.id === row.value.id || (c.name + ' ' + c.id).toLowerCase().includes(memberSearch.value.toLowerCase()),
      ),
)
function origin(id: string) {
  return (
    (assigned.value && (book.value.rows.find(r => r.scope === 'character' && r.id === id) || groupOf(id))) ||
    book.value.rows.find(r => r.scope === 'pack')
  )
}
watch(
  [row, line, assigned, book],
  () => {
    report.value = undefined
  },
  { deep: true, flush: 'sync' },
)
function pick(selected?: PresetRow, scope: PresetScope = 'pack') {
  row.value = selected ? copy(selected) : fresh(scope)
  base.value = selected ? copy(selected) : null
  if (!selected && scope === 'character') row.value.id = availableCharacters.value[0]?.id ?? ''
  baseline.value = JSON.stringify(row.value)
  revision.value++
  memberSearch.value = ''
  pendingDelete.value = false
  conflict.value = undefined
}
async function reload(id?: string) {
  book.value = await editorRequest<Book>('presets')
  pick(book.value.rows.find(r => key(r) === (id ?? 'pack/')))
}
async function run(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  notice.value = ''
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function request(data: Record<string, unknown>) {
  try {
    return await editorRequest<Result>('preset-save', data)
  } catch (e) {
    const err = e as {
      status?: number
      details?: { field: string; current: PresetRow | null; proposed: PresetRow | null; useCurrent: PresetRow | null }
    }
    if (err.status === 409 && err.details) {
      conflict.value = err.details
    }
    throw e
  }
}
function install(result: Result, selected: PresetRow | null) {
  book.value = { rows: result.rows, characters: result.characters }
  pick(selected ? book.value.rows.find(r => key(r) === key(selected)) : book.value.rows.find(r => r.scope === 'pack'))
  notice.value = '预设草稿已保存'
}
async function commit(original: PresetRow | null, proposed: PresetRow | null) {
  if (!original && !proposed) {
    await reload()
    return
  }
  const result = await request({ base: original, row: proposed })
  install(result, proposed)
}
async function save(force = false) {
  if (conflict.value) throw new Error('请先处理预设的并发修改')
  if (dirty.value || (force && !base.value)) await commit(base.value, row.value)
}
async function flush() {
  if (busy.value) throw new Error('预设正在处理，请稍后再切换')
  busy.value = true
  try {
    await save()
  } finally {
    busy.value = false
  }
}
defineExpose({ flush, reload: () => run(() => reload(key(row.value))) })
function select(id: string | undefined, scope: PresetScope = 'pack') {
  void run(async () => {
    await save()
    book.value = await editorRequest<Book>('presets')
    pick(
      book.value.rows.find(r => key(r) === id),
      scope,
    )
  })
}
async function resolveConflict(local: boolean) {
  const c = conflict.value
  if (c) await commit(c.current, local ? c.proposed : c.useCurrent)
}
async function check() {
  await save()
  const out = await editorRequest<{ entries: number }>('preset-validate')
  notice.value = '校验通过，共 ' + out.entries + ' 条随包预设'
}
async function play() {
  await save()
  report.value = await editorRequest('preset-play', {
    text: line.value,
    assigned: assigned.value,
    expected: base.value ?? undefined,
  })
}
function number(k: (typeof numeric)[number][0], e: Event) {
  const el = e.target as HTMLInputElement
  if (el.value === '') delete row.value.preset[k]
  else row.value.preset[k] = el.valueAsNumber
}
function stops(e: Event) {
  const text = (e.target as HTMLTextAreaElement).value
  if (text === '') delete row.value.preset.stop
  else row.value.preset.stop = text.split('\n')
}
function updatePrompt(e: Event) {
  const text = (e.target as HTMLTextAreaElement).value
  if (text) row.value.preset.prompt = text
  else delete row.value.preset.prompt
}
onMounted(() => void run(() => reload(props.initialKey)))
</script>
<template>
  <section class="preset-desk">
    <header>
      <h2>文风与模型预设</h2>
      <button :disabled="busy" @click="run(check)">校验预设</button>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="busy || notice" role="status">{{ busy ? '正在处理…' : notice }}</p>
    <fieldset :disabled="busy">
      <aside>
        <label>查找预设<input type="search" v-model="search" placeholder="名称、角色或 ID" /></label>
        <button v-if="!book.rows.some(r => r.scope === 'pack')" @click="select(undefined)">设置包推荐</button>
        <button
          v-for="r in rows"
          :key="key(r)"
          class="entry"
          :aria-pressed="!!base && key(base) === key(r)"
          @click="select(key(r))"
        >
          <b>{{ name(r) }}</b
          ><small>{{ labels[r.scope] }}{{ r.id ? ' · ' + r.id : '' }}</small>
        </button>
        <button :disabled="!availableCharacters.length" @click="select(undefined, 'character')">新建角色专属</button
        ><button @click="select(undefined, 'group')">新建角色组</button>
      </aside>
      <article>
        <h3>{{ base ? name(base) : row.scope === 'pack' ? '包推荐' : '新建' + labels[row.scope] }}</h3>
        <p v-if="row.scope === 'pack'">作为作品的默认文风随包交付。</p>
        <div :inert="!!conflict">
          <label v-if="row.scope === 'character' && !base"
            >查找适用角色<input v-model="memberSearch" type="search" placeholder="角色名或 ID"
          /></label>
          <label v-if="row.scope === 'character'"
            >适用角色 · 必填<select v-model="row.id" :disabled="!!base">
              <option value="" disabled>选择可调用的角色</option>
              <option v-if="base && !book.characters.some(c => c.id === row.id)" :value="row.id">
                失效引用 · {{ row.id }}
              </option>
              <option v-for="c in eligible" :key="c.id" :value="c.id">{{ c.name }} · {{ c.id }}</option>
            </select></label
          >
          <template v-if="row.scope === 'group'"
            ><label>角色组名 · 必填<input v-model="row.id" :readonly="!!base" maxlength="80" /></label>
            <label>查找组成员<input v-model="memberSearch" type="search" placeholder="角色名或 ID" /></label>
            <label
              >组成员 · 至少一人<select v-model="row.members" multiple>
                <option
                  v-for="id in row.members?.filter(id => !book.characters.some(c => c.id === id))"
                  :key="id"
                  :value="id"
                >
                  失效引用 · {{ id }}
                </option>
                <option
                  v-for="c in members"
                  :key="c.id"
                  :value="c.id"
                  :disabled="!!groupOf(c.id) && groupOf(c.id)?.id !== row.id"
                >
                  {{ c.name }} · {{ c.id
                  }}{{ groupOf(c.id) && groupOf(c.id)?.id !== row.id ? '（已属' + groupOf(c.id)?.id + '）' : '' }}
                </option>
              </select></label
            ></template
          >
          <label
            >附加文风提示 · 选填<textarea
              rows="3"
              maxlength="16000"
              :value="row.preset.prompt ?? ''"
              @input="updatePrompt"
              placeholder="例如：多用短句，给对方留出接话的余地。"
            />
          </label>
          <PresetContentEditor
            :key="revision"
            :model-value="row.preset"
            @update:model-value="(p: RolePreset) => (row.preset = p)"
          />
          <details>
            <summary>生成参数 · 选填</summary>
            <div class="numbers">
              <label v-for="[k, label, min, max] in numeric" :key="k"
                >{{ label }}（{{ min }}–{{ max }}）<input
                  type="number"
                  :min="min"
                  :max="max"
                  :step="k === 'maxOutputTokens' ? 1 : 0.01"
                  :value="row.preset[k]"
                  @input="number(k, $event)"
              /></label>
            </div>
            <label
              >停止词 · 每行一项，最多四项<textarea rows="2" :value="row.preset.stop?.join('\n')" @input="stops" />
            </label>
          </details>
        </div>
        <div v-if="conflict" role="alert">
          <strong>字段发生冲突 · {{ conflict.field }}</strong>
          <details open>
            <summary>核对两个版本</summary>
            <pre>已保存 {{ JSON.stringify(conflict.current, null, 2) }}</pre>
            <pre>本次修改 {{ JSON.stringify(conflict.proposed, null, 2) }}</pre>
          </details>
          <button @click="run(() => resolveConflict(false))">采用已保存字段</button
          ><button @click="run(() => resolveConflict(true))">采用我的字段</button>
        </div>
        <div class="actions">
          <button class="primary" :disabled="(!dirty && !!base) || !!conflict" @click="run(() => save(true))">
            保存预设
          </button>
          <button v-if="dirty || conflict" @click="run(() => reload(base ? key(base) : undefined))">
            放弃本次输入
          </button>
          <button v-if="base && !pendingDelete" :disabled="!!conflict" @click="pendingDelete = true">移除此预设</button>
          <template v-if="pendingDelete"
            ><button @click="run(() => commit(base, null))">确认移除</button> ><button @click="pendingDelete = false">
              取消移除
            </button></template
          >
        </div>
        <section class="trial">
          <h3>预设作用范围</h3>
          <label
            >试玩分配方式<select v-model="assigned">
              <option :value="false">仅用包推荐</option>
              <option :value="true">已分配随包角色预设</option>
            </select></label
          >
          <p>分配后，每名角色按「角色专属 → 角色组 → 包推荐」取第一份适用预设。</p>
          <ul>
            <li v-for="c in book.characters" :key="c.id">
              {{ c.name }} →
              <button v-if="origin(c.id)" @click="select(key(origin(c.id)!))">
                {{ labels[origin(c.id)!.scope]
                }}{{ origin(c.id)!.scope === 'group' ? ' · ' + origin(c.id)!.id : '' }}</button
              ><span v-else>宿主默认</span>
            </li>
          </ul>
          <label>玩家发言<input v-model="line" maxlength="2000" placeholder="门廊今天好安静。" /></label>
          <button :disabled="!line.trim() || !!conflict" @click="run(play)">核对实际角色请求</button>
          <section v-if="report" class="report">
            <h4>{{ report.assigned ? '已分配随包角色预设' : '仅用包推荐' }} · {{ report.text }}</h4>
            <p v-if="report.notice">{{ report.notice }}</p>
            <p v-if="!report.actors.length">包内没有可调用角色。</p>
            <div v-for="a in report.actors" :key="a.id">
              <h4>{{ a.name }} · {{ a.id }}</h4>
              <p v-if="!a.requests.length">本轮未发起请求</p>
              <div v-for="(r, i) in a.requests" :key="i">
                <strong>请求 {{ i + 1 }} · {{ r.name }} · {{ r.status }}</strong>
                <p v-if="r.omitted">{{ r.omitted }}</p>
                <template v-else
                  ><p>生成参数 {{ JSON.stringify(r.generation) }}</p>
                  <p v-if="!r.messages.length">本次请求没有附加提示或启用的提示节点。</p>
                  <div v-for="m in r.messages" :key="m.order">
                    <small>消息 {{ m.order }} · {{ m.name }} · {{ m.role }}</small>
                    <pre>{{ m.content }}</pre>
                  </div></template
                >
              </div>
            </div>
          </section>
        </section>
      </article>
    </fieldset>
  </section>
</template>
<style scoped>
.preset-desk {
  --border: #bbc9be;
  --background: #fff;
  --foreground: #243e35;
  --muted: #eef3ef;
  --muted-foreground: #415d4c;
  --danger: #953528;
  padding: 22px 26px;
  color: var(--foreground);
  min-width: 0;
}
header,
.actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
header {
  justify-content: space-between;
}
h2,
h3 {
  margin: 0 0 10px;
}
h4 {
  margin: 10px 0 5px;
}
fieldset {
  display: grid;
  grid-template-columns: minmax(160px, 30%) minmax(0, 1fr);
  border: 0;
  border-top: 1px solid var(--border);
  padding: 0;
  margin: 14px 0;
  min-width: 0;
}
aside {
  padding: 14px 14px 0 0;
  border-right: 1px solid var(--border);
}
article {
  max-width: 800px;
  min-width: 0;
  padding: 16px;
}
button {
  cursor: pointer;
  color: inherit;
  border: 1px solid #a7b9ac;
  background: white;
  border-radius: 4px;
  padding: 6px 10px;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.primary,
.entry[aria-pressed='true'] {
  background: #285344;
  color: white;
}
.entry {
  display: block;
  text-align: left;
  width: 100%;
  margin: 5px 0;
}
small {
  display: block;
  overflow-wrap: anywhere;
}
label {
  display: grid;
  gap: 4px;
  margin: 8px 0;
}
input,
select,
textarea {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  color: inherit;
  background: white;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 7px;
}
.numbers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 10px;
}
details,
.actions,
.trial {
  margin-top: 15px;
}
summary {
  cursor: pointer;
}
.trial {
  border-top: 1px solid var(--border);
  padding-top: 14px;
}
.trial ul {
  list-style: none;
  padding: 0;
}
.trial li {
  margin: 4px 0;
}
.report {
  border-left: 3px solid #6b8974;
  background: #f2f5f0;
  padding: 9px 14px;
}
pre {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
[role='alert'] {
  color: #973426;
}
@media (max-width: 760px) {
  .preset-desk {
    padding: 14px;
  }
  fieldset {
    grid-template-columns: 1fr;
  }
  aside {
    border: 0;
  }
  article {
    padding: 14px 0;
  }
}
</style>
