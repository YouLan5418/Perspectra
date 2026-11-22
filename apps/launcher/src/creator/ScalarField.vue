<script setup lang="ts">
import type { EditorVariable, Scalar } from '@perspectra/world-pack/editor-fields'
defineProps<{ definition: EditorVariable; modelValue: Scalar }>()
const emit = defineEmits<{ 'update:modelValue': [value: Scalar] }>()
</script>
<template>
  <select
    v-if="definition.type === 'boolean'"
    :value="String(modelValue)"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value === 'true')"
  >
    <option value="true">是</option>
    <option value="false">否</option>
  </select>
  <select
    v-else-if="definition.options?.length"
    :value="modelValue"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="s in definition.options" :key="s">{{ s }}</option>
  </select>
  <input
    v-else
    :type="definition.type === 'number' ? 'number' : 'text'"
    :value="String(modelValue)"
    :step="definition.type === 'number' ? '1' : undefined"
    @input="
      emit(
        'update:modelValue',
        definition.type === 'number'
          ? ($event.target as HTMLInputElement).valueAsNumber
          : ($event.target as HTMLInputElement).value,
      )
    "
  />
</template>
