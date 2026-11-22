<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { editorRequest } from './editor-api.ts'
import type { activityPageCandidates, PageFieldChoice } from '../../../host/src/editor/activity-page-candidates.ts'
import type { PageElement, PageRule } from '../../../host/src/runtime/activity-page-rules.ts'

const rows = defineModel<PageElement[]>({ required: true })
const props = defineProps<{
  activity: string
  html: string
  files: string[]
  scenes: Record<string, string>
  initialElement?: string | undefined
}>()
type Catalog = Awaited<ReturnType<typeof activityPageCandidates>>
const catalog = ref<Catalog>(),
  selected = ref(props.initialElement ?? ''),
  error = ref(''),
  loading = ref(false),
  sampledText = ref('')
const images = computed(() => props.files.filter(f => /\.(png|jpe?g|webp|gif|svg)$/i.test(f)))
const row = computed(() => rows.value.find(e => e.id === selected.value))
const target = computed(() => catalog.value?.targets.find(e => e.id === selected.value))
const missing = computed(() => rows.value.filter(e => !catalog.value?.targets.some(t => t.id === e.id)))
let epoch = 0
async function refresh(trial: boolean) {
  const ticket = ++epoch
  loading.value = true
  error.value = ''
  sampledText.value = ''
  try {
    const book = await editorRequest<Catalog>('activity-page-candidates', {
      key: props.activity,
      html: props.html,
      trial,
      scenes: Object.fromEntries(Object.entries(props.scenes).filter(([, s]) => s)),
    })
    if (ticket !== epoch) return
    catalog.value = book
    if (!book.targets.some(t => t.id === selected.value) && !row.value)
      selected.value = rows.value[0]?.id ?? book.targets[0]?.id ?? ''
    if (trial)
      sampledText.value = book.sampled
        ? '已读取当前活动的玩家视图。'
        : '当前起点尚未进入该活动；可调整试玩起点后再读取。'
  } catch (e) {
    if (ticket === epoch) error.value = (e as Error).message
  } finally {
    if (ticket === epoch) loading.value = false
  }
}
watch(
  () => [props.activity, props.html, props.files, props.scenes],
  () => {
    catalog.value = undefined
    void refresh(false)
  },
  { immediate: true, deep: true },
)
function edit(operation: string | undefined, rules: PageRule[]) {
  const id = selected.value
  const other = rows.value.filter(e => e.id !== id)
  rows.value =
    operation || rules.length
      ? [...other, { id, ...(operation ? { operation } : {}), ...(rules.length ? { rules } : {}) }]
      : other
}
function rules(list: PageRule[]) {
  edit(row.value?.operation, list)
}
function change(i: number, patch: Partial<PageRule>) {
  rules((row.value?.rules ?? []).map((r, index) => (index === i ? { ...r, ...patch } : r)))
}
const fieldId = (s: PageRule['field']) => JSON.stringify(s)
function choice(r: PageRule) {
  return catalog.value?.fields.find(f => fieldId(f.field) === fieldId(r.field))
}
function defaultValue(f: PageFieldChoice) {
  return f.type === 'boolean' ? true : f.type === 'number' ? 0 : (f.options?.[0] ?? '')
}
function newRule() {
  const f = catalog.value?.fields[0]
  if (f)
    rules([
      ...(row.value?.rules ?? []),
      { field: f.field, compare: 'eq', value: defaultValue(f), effect: { kind: 'show' } },
    ])
}
function selectField(i: number, id: string) {
  const f = catalog.value?.fields.find(f => fieldId(f.field) === id)
  if (f) change(i, { field: f.field, compare: 'eq', value: defaultValue(f) })
}
function selectEffect(i: number, kind: string) {
  if (kind === 'show') change(i, { effect: { kind } })
  if (kind === 'image') change(i, { effect: { kind, value: images.value[0] ?? '' } })
  if (kind === 'class') change(i, { effect: { kind, value: '' } })
}
const val = (e: Event) => (e.target as HTMLInputElement).value
</script>
<template>
  <section class="element-rules">
    <h4>元素交互与显示</h4>
    <p v-if="error" role="alert">{{ error }}</p>
    <label
      >页面元素<select v-model="selected" aria-label="页面元素">
        <option v-for="t in catalog?.targets" :key="t.id" :value="t.id">{{ t.label }} · #{{ t.id }}</option>
        <option v-for="t in missing" :key="t.id" :value="t.id">找不到元素 · #{{ t.id }}</option>
      </select></label
    >
    <p v-if="catalog && !catalog.targets.length">在 HTML 中给需要配置的元素添加唯一的 id，然后重新读取。</p>
    <button type="button" :disabled="loading" @click="refresh(true)">读取试玩字段和操作</button>
    <span role="status">{{ loading ? '正在读取…' : sampledText }}</span>
    <div v-if="selected && catalog">
      <label v-if="target?.tag === 'button' || row?.operation"
        >点击时执行什么<select :value="row?.operation ?? ''" @change="edit(val($event) || undefined, row?.rules ?? [])">
          <option value="">沿用 HTML 设置</option>
          <option
            v-if="row?.operation && !catalog.operations.some(o => o.id === row?.operation)"
            :value="row.operation"
          >
            已绑定 · {{ row.operation }}
          </option>
          <option v-for="o in catalog.operations" :key="o.id" :value="o.id">{{ o.label }} · {{ o.id }}</option>
        </select></label
      >
      <h5>什么情况下这样显示</h5>
      <div v-for="(r, i) in row?.rules" :key="i" class="rule-row">
        <label
          >条件字段<select :value="fieldId(r.field)" @change="selectField(i, val($event))">
            <option v-if="!choice(r)" :value="fieldId(r.field)">已绑定 · {{ fieldId(r.field) }}</option>
            <option v-for="f in catalog.fields" :key="fieldId(f.field)" :value="fieldId(f.field)">{{ f.label }}</option>
          </select></label
        >
        <label
          >比较<select :value="r.compare" @change="change(i, { compare: val($event) as PageRule['compare'] })">
            <option value="eq">等于</option>
            <option value="ne">不等于</option>
            <template v-if="typeof r.value === 'number'"
              ><option value="lt">小于</option>
              <option value="lte">小于等于</option>
              <option value="gt">大于</option>
              <option value="gte">大于等于</option></template
            >
          </select></label
        >
        <label
          >目标值<select
            v-if="typeof r.value === 'boolean'"
            :value="String(r.value)"
            @change="change(i, { value: val($event) === 'true' })"
          >
            <option value="true">是</option>
            <option value="false">否</option>
          </select>
          <input
            v-else-if="typeof r.value === 'number'"
            type="number"
            step="any"
            :value="r.value"
            @input="change(i, { value: ($event.target as HTMLInputElement).valueAsNumber })" />
          <template v-else
            ><input :list="'rule-values-' + i" :value="r.value" @input="change(i, { value: val($event) })" /><datalist
              :id="'rule-values-' + i"
            >
              <option v-for="s in choice(r)?.options" :key="s" :value="s" /></datalist></template
        ></label>
        <label
          >满足条件时<select :value="r.effect.kind" @change="selectEffect(i, val($event))">
            <option value="show">显示元素，否则隐藏</option>
            <option value="class">应用 CSS 类</option>
            <option value="image">更换图片或背景</option>
          </select></label
        >
        <label v-if="r.effect.kind === 'class'"
          >CSS 类名<input
            :value="r.effect.value"
            placeholder="例如 damaged"
            @input="change(i, { effect: { kind: 'class', value: val($event) } })"
        /></label>
        <label v-if="r.effect.kind === 'image'"
          >包内图片<select
            :value="r.effect.value"
            @change="change(i, { effect: { kind: 'image', value: val($event) } })"
          >
            <option value="">请选择图片</option>
            <option v-if="r.effect.value && !images.includes(r.effect.value)" :value="r.effect.value">
              文件缺失 · {{ r.effect.value }}
            </option>
            <option v-for="f in images" :key="f">{{ f }}</option>
          </select></label
        >
        <button @click="rules((row?.rules ?? []).filter((_, j) => i !== j))">删除条件</button>
      </div>
      <button :disabled="!target" @click="newRule">添加显示条件</button>
      <button v-if="row" @click="edit(undefined, [])">清除此元素绑定</button>
    </div>
  </section>
</template>
<style scoped>
.element-rules {
  border-block: 1px solid #c9d2cc;
  padding: 12px 0;
  margin: 16px 0;
}
h4,
h5 {
  margin: 8px 0;
}
label {
  display: grid;
  gap: 4px;
  margin: 8px 0;
}
select,
input,
button {
  font: inherit;
  color: inherit;
  padding: 6px;
  border: 1px solid #a7b9ac;
  border-radius: 4px;
  background: white;
  min-width: 0;
}
button {
  cursor: pointer;
  margin: 3px 6px 3px 0;
}
.rule-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 4px 12px;
  padding: 10px;
  background: #f3f6f2;
  margin-bottom: 8px;
}
.rule-row button {
  justify-self: start;
  align-self: end;
}
span,
p {
  font-size: 0.9em;
}
[role='alert'] {
  color: #953528;
}
</style>
