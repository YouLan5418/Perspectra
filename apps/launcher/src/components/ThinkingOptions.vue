<script setup lang="ts">
import type { ThinkingLevel } from '../core-types.ts'
import { geminiRequired } from '../model-choices.ts'
const props = defineProps<{ modelValue: ThinkingLevel; model: string; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [ThinkingLevel] }>()
const options = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
] as const
</script>
<template>
  <div class="form-field">
    <label>{{ label }}</label>
    <div class="thinking-options" role="group" :aria-label="label">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        :disabled="option.value === 'off' && geminiRequired(props.model)"
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
