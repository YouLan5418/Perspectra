<script setup lang="ts">
import { ref, watch } from 'vue'
import type { ThinkingLevel } from '../core-types.ts'
import { fitThinkingLevel } from '../model-choices.ts'
import { thinkingLevels } from '../services/desktop.ts'
const props = defineProps<{
  modelValue: ThinkingLevel
  connectionId?: string | undefined
  model: string
  label: string
}>()
const emit = defineEmits<{ 'update:modelValue': [ThinkingLevel] }>()
const options = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
] as const
const all: ThinkingLevel[] = ['off', 'low', 'medium', 'high']
const offered = ref<ThinkingLevel[]>(all)
// The model's declaration decides which levels exist; an unreachable backend leaves all four open.
watch(
  () => [props.connectionId, props.model.trim()] as const,
  async ([connectionId, model]) => {
    let levels = all
    if (connectionId && model) {
      try {
        levels = await thinkingLevels(connectionId, model)
      } catch {
        levels = all
      }
    }
    if (connectionId !== props.connectionId || model !== props.model.trim()) return
    offered.value = levels
    const fitted = fitThinkingLevel(props.modelValue, levels)
    if (fitted !== props.modelValue) emit('update:modelValue', fitted)
  },
  { immediate: true },
)
</script>
<template>
  <div class="form-field">
    <label>{{ label }}</label>
    <div class="thinking-options" role="group" :aria-label="label">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        :disabled="!offered.includes(option.value)"
        :aria-pressed="modelValue === option.value"
        :class="{ selected: modelValue === option.value }"
        @click="emit('update:modelValue', option.value)"
      >
        {{ option.label }}
      </button>
    </div>
  </div>
</template>
<style scoped>
.thinking-options {
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--muted);
  border-radius: 12px;
}
.thinking-options button {
  flex: 1;
  border: 0;
  border-radius: 8px;
  padding: 9px 14px;
  background: transparent;
  cursor: pointer;
  color: inherit;
}
.thinking-options button.selected {
  background: #2563eb;
  color: white;
}
.thinking-options button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.thinking-options button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
</style>
