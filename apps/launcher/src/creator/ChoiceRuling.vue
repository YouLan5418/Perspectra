<script setup lang="ts">
import { computed, ref } from 'vue'
import { acceptsVariableValue, rulingTargets, type Scalar } from '@perspectra/world-pack/editor-fields'
import type { EditorChoice, EditorGraph } from '../../../host/src/editor/activity-graph.ts'
import type { EditorProject } from '../../../host/src/editor/project.ts'
import type { ChoiceRuling } from '../../../host/src/editor/adjudication.ts'
import ScalarField from './ScalarField.vue'
const props = defineProps<{ choice: EditorChoice; graph: EditorGraph; project: EditorProject }>()
const emit = defineEmits<{ change: [rule: ChoiceRuling | undefined]; open: [id: string] }>()
const targetInput = ref<HTMLSelectElement>()
const scriptInput = ref<HTMLSelectElement>()
defineExpose({
  focus(field = 'ruling') {
    ;(field === 'script' ? scriptInput : targetInput).value?.focus()
  },
})
const rule = computed(() => props.choice.ruling)
const targets = computed(() =>
  rulingTargets(props.project.rules.variables, props.graph.variables ?? [], props.graph.key),
)
const scripts = computed(() => props.project.adjudications.flatMap(s => (s.declaration ? [s.declaration] : [])))
const selected = computed(() =>
  rule.value?.kind === 'script' ? 'script/' + rule.value.script : (rule.value?.kind ?? ''),
)
const script = computed(() => scripts.value.find(s => 'script/' + s.key === selected.value))
const type = computed(() => script.value?.type ?? 'number')
const options = computed(() => targets.value.filter(t => t.type === type.value))
const outdated = computed(() => {
  const r = rule.value,
    s = script.value
  return (
    r?.kind === 'script' &&
    !!s &&
    (Object.keys(r.parameters).length !== s.parameters.length ||
      s.parameters.some(p => !acceptsVariableValue(p, r.parameters[p.key])))
  )
})
const targetKey = computed(() => (rule.value ? rule.value.target.kind + '/' + rule.value.target.ref : ''))
function choose(mode: string) {
  if (!mode) {
    emit('change', undefined)
    return
  }
  const s = scripts.value.find(s => 'script/' + s.key === mode)
  const matches = targets.value.filter(v => v.type === (s?.type ?? 'number'))
  const v = matches.find(t => t.kind + '/' + t.key === targetKey.value) ?? matches[0]
  if (!v) return
  const target = { kind: v.kind, ref: v.key }
  emit(
    'change',
    s
      ? {
          kind: 'script',
          target,
          script: s.key,
          parameters: Object.fromEntries(s.parameters.map(p => [p.key, p.initial])),
        }
      : { kind: 'cost', target, amount: 1, rejectReason: '精力不足。' },
  )
}
function setTarget(key: string) {
  const v = options.value.find(t => t.kind + '/' + t.key === key)
  if (v && rule.value) emit('change', { ...rule.value, target: { kind: v.kind, ref: v.key } })
}
function parameter(key: string, value: Scalar) {
  const r = rule.value
  if (r?.kind === 'script') emit('change', { ...r, parameters: { ...r.parameters, [key]: value } })
}
</script>
<template>
  <fieldset class="ruling">
    <legend>操作裁定</legend>
    <label
      >裁定方式<select
        ref="scriptInput"
        :aria-invalid="rule?.kind === 'script' && (!script || outdated)"
        :value="selected"
        @change="choose(($event.target as HTMLSelectElement).value)"
      >
        <option value="">直接执行结果</option>
        <option value="cost" :disabled="!targets.some(v => v.type === 'number')">消耗数值</option>
        <option v-if="rule?.kind === 'script' && !script" :value="selected">失效的脚本 · {{ rule.script }}</option>
        <option
          v-for="s in scripts"
          :key="s.key"
          :value="'script/' + s.key"
          :disabled="!targets.some(v => v.type === s.type)"
        >
          {{ s.title }} · {{ s.key }}
        </option>
      </select></label
    >
    <small v-if="!targets.length">先在活动或世界变量表中声明可读写的变量，即可绑定裁定。</small>
    <template v-if="rule"
      ><label
        >裁定变量<select
          ref="targetInput"
          :aria-invalid="!options.some(v => v.kind + '/' + v.key === targetKey)"
          :value="targetKey"
          @change="setTarget(($event.target as HTMLSelectElement).value)"
        >
          <option v-if="!options.some(v => v.kind + '/' + v.key === targetKey)" :value="targetKey">
            失效的引用 · {{ targetKey }}
          </option>
          <option v-for="v in options" :key="v.kind + '/' + v.key" :value="v.kind + '/' + v.key">
            {{ v.kind === 'world' ? '世界' : '本活动' }} · {{ v.label }}
          </option>
        </select></label
      >
      <template v-if="rule.kind === 'cost'"
        ><label
          >消耗量<input
            type="number"
            min="1"
            step="1"
            :value="rule.amount"
            @input="emit('change', { ...rule, amount: ($event.target as HTMLInputElement).valueAsNumber })"
        /></label>
        <label
          >不足时的提示<input
            :value="rule.rejectReason"
            maxlength="2000"
            @input="emit('change', { ...rule, rejectReason: ($event.target as HTMLInputElement).value })" /></label
      ></template>
      <template v-if="rule.kind === 'script' && script"
        ><label v-for="p in script.parameters" :key="p.key"
          >{{ p.label
          }}<ScalarField
            :definition="p"
            :model-value="rule.parameters[p.key] ?? p.initial"
            @update:model-value="parameter(p.key, $event)"
        /></label>
        <button type="button" @click="emit('open', script.key)">查看裁定源码</button>
        <button v-if="outdated" type="button" @click="choose(selected)">按最新声明重设参数</button></template
      >
    </template>
  </fieldset>
</template>
<style scoped>
.ruling {
  border: 1px solid #bac8be;
  padding: 12px;
  margin: 12px 0;
  display: grid;
  gap: 8px;
}
.ruling label {
  display: grid;
  gap: 4px;
}
.ruling legend {
  font-weight: 600;
}
[aria-invalid='true'] {
  color: #a22;
  border-color: #a22;
}
</style>
