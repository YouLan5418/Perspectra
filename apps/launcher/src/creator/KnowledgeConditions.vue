<script setup lang="ts">
import {
  knowledgeComparators,
  knowledgeComparisons,
  knowledgeField,
  type KnowledgeCondition,
  type KnowledgeField,
  type KnowledgeTerm,
} from '@perspectra/world-pack/editor-knowledge'
import type { knowledgeFields } from '../../../host/src/editor/knowledge-fields.ts'
const props = defineProps<{ group: KnowledgeCondition; book: Awaited<ReturnType<typeof knowledgeFields>> }>()
const emit = defineEmits<{ change: [group: KnowledgeCondition] }>()
const field = (t: KnowledgeTerm) => knowledgeField(props.book.fields, t.path, t.activity)
const fieldId = (f: KnowledgeField | undefined) => f && JSON.stringify([f.activity ?? '', f.path])
function make(f: KnowledgeField): KnowledgeTerm {
  const path = f.path.map((k, j) => (k !== '*' ? k : (keys(f, j)[0] ?? '')))
  const comparison = knowledgeComparators(f)[0]!
  return {
    path,
    ...(f.activity ? { activity: f.activity } : {}),
    comparison,
    ...(comparison === 'known'
      ? {}
      : { value: f.choices?.[0]?.value ?? (f.type === 'number' ? 0 : f.type === 'boolean' ? true : '') }),
  }
}
function keys(f: KnowledgeField, index: number) {
  if (f.path[0] === 'characters' && index === 1) return props.book.actors.map(a => String(a.value))
  return [
    ...new Set(
      [...props.book.paths, ...props.group.terms.map(t => t.path)]
        .filter(p => p.length > index && f.path.slice(0, index).every((k, i) => k === '*' || k === p[i]))
        .map(p => p[index])
        .filter((k): k is string => typeof k === 'string' && !!k),
    ),
  ]
}
function terms(list: KnowledgeTerm[]) {
  emit('change', { match: props.group.match === 'one' && list.length > 1 ? 'all' : props.group.match, terms: list })
}
function update(i: number, t: KnowledgeTerm) {
  const list = [...props.group.terms]
  list[i] = t
  terms(list)
}
function setKey(i: number, j: number, value: string) {
  const t = props.group.terms[i]!,
    path = [...t.path]
  path[j] = value
  update(i, { ...t, path })
}
function compare(i: number, comparison: KnowledgeTerm['comparison']) {
  const t = props.group.terms[i]!,
    f = field(t)!
  if (comparison === 'known') update(i, { path: t.path, ...(t.activity ? { activity: t.activity } : {}), comparison })
  else update(i, { ...t, comparison, value: t.value ?? make(f).value! })
}
</script>
<template>
  <fieldset class="knowledge-conditions">
    <legend>按读者可见字段判断</legend>
    <label
      >组合方式<select
        aria-label="组合方式"
        :value="group.match === 'any' ? 'any' : 'all'"
        @change="
          emit('change', { ...group, match: ($event.target as HTMLSelectElement).value === 'any' ? 'any' : 'all' })
        "
      >
        <option value="all">全部满足</option>
        <option value="any">任一满足</option>
      </select></label
    >
    <div v-for="(t, i) in group.terms" :key="i">
      <label
        >条件字段<select
          :aria-label="'条件字段 ' + (i + 1)"
          :value="fieldId(field(t))"
          @change="update(i, make(book.fields.find(f => fieldId(f) === ($event.target as HTMLSelectElement).value)!))"
        >
          <option v-for="f in book.fields" :key="fieldId(f)" :value="fieldId(f)">
            {{ f.label }}
          </option>
        </select></label
      >
      <template v-if="field(t)"
        ><template v-for="(k, j) in field(t)!.path" :key="j"
          ><label v-if="k === '*'"
            >{{ j === 1 && t.path[0] === 'characters' ? '状态所属角色' : '记录键' }}
            <select
              v-if="j === 1 && t.path[0] === 'characters'"
              :value="t.path[j]"
              :aria-label="'状态所属角色 ' + (i + 1)"
              @change="setKey(i, j, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="a in book.actors" :value="a.value" :key="a.value">{{ a.label }}</option>
            </select>
            <template v-else
              ><input
                :aria-label="'记录键 ' + (i + 1) + '-' + j"
                :list="'known-keys-' + i + '-' + j"
                :value="t.path[j]"
                @input="setKey(i, j, ($event.target as HTMLInputElement).value)" /><datalist
                :id="'known-keys-' + i + '-' + j"
              >
                <option v-for="key in keys(field(t)!, j)" :key="key" :value="key" /></datalist
            ></template> </label
        ></template>
        <label
          >比较方式<select
            :aria-label="'比较方式 ' + (i + 1)"
            :value="t.comparison"
            @change="compare(i, ($event.target as HTMLSelectElement).value as KnowledgeTerm['comparison'])"
          >
            <option v-for="c in knowledgeComparators(field(t)!)" :key="c" :value="c">
              {{ c === 'ne' && t.path.includes(null) ? '有一项不等于' : knowledgeComparisons[c] }}
            </option>
          </select></label
        >
        <label v-if="t.comparison !== 'known'"
          >条件值<select
            v-if="field(t)!.choices && !field(t)!.openChoices && ['eq', 'ne'].includes(t.comparison)"
            :aria-label="'条件值 ' + (i + 1)"
            :value="JSON.stringify(t.value)"
            @change="update(i, { ...t, value: JSON.parse(($event.target as HTMLSelectElement).value) })"
          >
            <option v-for="c in field(t)!.choices" :key="JSON.stringify(c.value)" :value="JSON.stringify(c.value)">
              {{ c.label }}
            </option>
          </select>
          <select
            v-else-if="field(t)!.type === 'boolean'"
            :aria-label="'条件值 ' + (i + 1)"
            :value="String(t.value)"
            @change="update(i, { ...t, value: ($event.target as HTMLSelectElement).value === 'true' })"
          >
            <option value="true">是</option>
            <option value="false">否</option>
          </select>
          <input
            v-else-if="field(t)!.type === 'number'"
            :aria-label="'条件值 ' + (i + 1)"
            type="number"
            step="any"
            :value="t.value"
            @input="update(i, { ...t, value: ($event.target as HTMLInputElement).valueAsNumber })"
          />
          <input
            v-else
            :aria-label="'条件值 ' + (i + 1)"
            :list="field(t)!.openChoices ? 'knowledge-values-' + i : undefined"
            :value="t.value"
            @input="update(i, { ...t, value: ($event.target as HTMLInputElement).value })"
          /><datalist v-if="field(t)!.openChoices" :id="'knowledge-values-' + i">
            <option v-for="c in field(t)!.choices" :key="c.label" :value="String(c.value)">{{ c.label }}</option>
          </datalist></label
        >
      </template>
      <button type="button" v-if="group.terms.length > 1" @click="terms(group.terms.filter((_, j) => j !== i))">
        移除此条件
      </button>
    </div>
    <button type="button" @click="terms([...group.terms, make(book.fields[0]!)])">添加知识条件</button>
    <small v-if="book.warning">{{ book.warning }}</small>
  </fieldset>
</template>
<style scoped>
.knowledge-conditions,
.knowledge-conditions > div {
  display: grid;
  gap: 0.4rem;
}
.knowledge-conditions > div {
  border-block-end: 1px solid #cfdfd8;
  padding-block: 0.5rem;
}
button {
  justify-self: start;
}
</style>
