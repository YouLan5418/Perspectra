<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import type { ModelTarget, ThinkingLevel } from '../core-types.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
import ModelPicker from './ModelPicker.vue'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const target = ref<ModelTarget | undefined>()
const draft = reactive({ thinkingLevel: 'off' as ThinkingLevel })
const geminiRequired = (model: string) => /gemini-(?:[3-9]|2\.5-pro)/i.test(model)
watch(() => props.open, open => {
  if (!open) return
  const decision = store.currentModels?.decision
  target.value = decision && !store.currentRealInstance?.brokenConnection ? { connectionId: decision.connectionId, model: decision.model } : undefined
  draft.thinkingLevel = decision?.thinkingLevel ?? (geminiRequired(decision?.model ?? '') ? 'low' : 'off')
})
watch(() => target.value?.model ?? '', model => { if (draft.thinkingLevel === 'off' && geminiRequired(model)) draft.thinkingLevel = 'low' })
async function save() {
  if (!target.value?.model.trim()) return
  const decision = { connectionId: target.value.connectionId, model: target.value.model.trim(), thinkingLevel: draft.thinkingLevel }
  // Part A keeps existing overrides untouched; per-character editing arrives with runtime support.
  const characters = store.currentModels?.characters
  if (store.real && !await store.configureModels({ decision, ...(characters ? { characters } : {}) })) return
  emit('close')
}
</script>
<template><DialogFrame :open="open" title="模型配置" description="为这个实例选择角色使用的模型。连接与 API Key 在左下角“模型设置”里管理。" @close="emit('close')">
  <p v-if="store.currentRealInstance?.brokenConnection" class="inline-info">此实例原先使用的连接已删除，请重新选择。</p>
  <p v-if="!store.connections.length" class="inline-info">还没有模型连接。请先在左下角“模型设置”添加连接。</p>
  <template v-else>
    <ModelPicker v-model="target" label="所有角色" id-prefix="instance-default" />
    <div class="form-field"><label>角色思考强度</label><div class="thinking-options" role="group" aria-label="角色思考强度"><button v-for="option in ([{value:'off',label:'关闭'},{value:'low',label:'低'},{value:'medium',label:'中'},{value:'high',label:'高'}] as const)" :key="option.value" :disabled="option.value==='off' && geminiRequired(target?.model ?? '')" type="button" :aria-pressed="draft.thinkingLevel===option.value" :class="{selected:draft.thinkingLevel===option.value}" @click="draft.thinkingLevel=option.value">{{ option.label }}</button></div></div>
    <p class="muted">仅影响角色决策。更强的思考可能增加等待与消耗；DeepSeek 的中、高分别对应原生 high、max。Gemini 部分型号不能完全关闭。记忆整理暂时跟随这里的模型。</p>
    <p class="inline-info">按角色单独指定模型即将接入。</p>
  </template>
  <div class="dialog-actions"><Button variant="outline" @click="emit('close')">取消</Button><Button :disabled="store.busy || store.core.state === 'running' || !target?.model.trim()" @click="save">保存配置</Button></div>
</DialogFrame></template>

<style scoped>
.thinking-options{display:flex;gap:4px;padding:4px;background:var(--muted);border-radius:12px}
.thinking-options button{flex:1;border:0;border-radius:8px;padding:9px 14px;background:transparent;cursor:pointer;color:inherit}
.thinking-options button.selected{background:#2563eb;color:white}
.thinking-options button:disabled{opacity:.4;cursor:not-allowed}
.thinking-options button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
</style>
