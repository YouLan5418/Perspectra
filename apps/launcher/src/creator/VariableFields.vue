<script setup lang="ts">
import type { EditorVariable } from '@perspectra/world-pack/editor-fields'
import ScalarField from './ScalarField.vue'
const variable = defineModel<EditorVariable>({ required: true })
defineProps<{ locked?: boolean }>()
function changeType(type: string) {
  const { options: _options, ...v } = variable.value
  variable.value = {
    ...v,
    type: type as EditorVariable['type'],
    initial: type === 'boolean' ? false : type === 'number' ? 0 : '',
  }
}
function options(text: string) {
  const choices = text
    .split('，')
    .join(',')
    .split(',')
    .map(s => s.trim())
  if (text.trim())
    variable.value = {
      ...variable.value,
      options: choices,
      initial: choices.includes(String(variable.value.initial)) ? variable.value.initial : choices[0]!,
    }
  else {
    const v = { ...variable.value }
    delete v.options
    variable.value = v
  }
}
</script>
<template>
  <label>变量键（必填）<input v-model="variable.key" :disabled="locked" placeholder="porch-light" /></label>
  <label>显示名（必填）<input v-model="variable.label" maxlength="80" /></label>
  <label
    >类型<select :value="variable.type" @change="changeType(($event.target as HTMLSelectElement).value)">
      <option value="boolean">布尔</option>
      <option value="number">整数</option>
      <option value="string">文字</option>
    </select></label
  >
  <label v-if="variable.type === 'string'"
    >枚举选项（可选，用逗号分隔）<input
      :value="variable.options?.join('，')"
      @input="options(($event.target as HTMLInputElement).value)"
  /></label>
  <label>初值（必填）<ScalarField v-model="variable.initial" :definition="variable" /></label>
</template>
