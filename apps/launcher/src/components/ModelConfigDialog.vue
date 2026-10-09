<script setup lang="ts">
import { reactive, watch } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const draft = reactive({ thinkingLevel: 'off' as 'off' | 'low' | 'medium' | 'high', protocol: 'openai' as 'openai' | 'anthropic' | 'google', model: '', endpoint: '' })
watch(() => props.open, open => { if (open) Object.assign(draft, { ...store.currentRealModel, thinkingLevel: store.currentRealModel.thinkingLevel ?? (/gemini-(?:[3-9]|2\.5-pro)/i.test(store.currentRealModel.model) ? 'low' : 'off'), protocol: store.currentRealModel.protocol ?? 'openai' }) })
async function save() {
  if (store.real && !await store.configureModel({ ...draft })) return
  emit('close')
}
</script>
<template><DialogFrame :open="open" title="模型配置" description="此配置属于当前实例；所有角色与记忆整理共用此模型接口。" @close="emit('close')">
  <div class="form-field"><label for="instance-protocol">接口协议</label><select id="instance-protocol" v-model="draft.protocol"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic Messages</option><option value="google">Google Gemini</option></select></div>
  <p class="muted">填写完整请求地址：OpenAI 为 /v1/chat/completions；Anthropic 为 /v1/messages；Google 为 /v1beta/models/模型:generateContent，实际使用下方模型标识。API Key 不放入地址。</p>
  <div class="form-field"><label for="instance-model">模型标识</label><input id="instance-model" v-model="draft.model" autocomplete="off" /></div>
  <div class="form-field"><label for="instance-endpoint">接口地址</label><input id="instance-endpoint" v-model="draft.endpoint" type="url" autocomplete="off" /></div>
  <div class="form-field"><label>角色思考强度</label><div class="thinking-options" role="group" aria-label="角色思考强度"><button v-for="option in ([{value:'off',label:'关闭'},{value:'low',label:'低'},{value:'medium',label:'中'},{value:'high',label:'高'}] as const)" :key="option.value" :disabled="option.value==='off' && /gemini-(?:[3-9]|2\.5-pro)/i.test(draft.model)" type="button" :aria-pressed="draft.thinkingLevel===option.value" :class="{selected:draft.thinkingLevel===option.value}" @click="draft.thinkingLevel=option.value">{{ option.label }}</button></div></div>
  <p class="muted">仅影响角色决策，记忆整理和玩家输入解析保持原设置。更强的思考可能增加等待与消耗；DeepSeek 的中、高分别对应原生 high、max。Gemini 部分型号不能完全关闭。</p>
  <p v-if="draft.model.toLowerCase().includes('gemini') && draft.protocol==='openai'" class="muted">通过网关使用 Gemini 时，实际强度由网关映射决定；网关强制配置可能覆盖选择。不支持关闭的型号已禁用该档。</p>
  <p class="inline-info">角色独立映射暂未接入。认证在左下角“模型设置”填写，仅保留在本次会话。</p>
  <div class="dialog-actions"><Button variant="outline" @click="emit('close')">取消</Button><Button :disabled="store.busy || store.core.state === 'running'" @click="save">保存配置</Button></div>
</DialogFrame></template>

<style scoped>
.thinking-options{display:flex;gap:4px;padding:4px;background:var(--surface-soft,#f1f5f9);border-radius:12px}
.thinking-options button{flex:1;border:0;border-radius:8px;padding:9px 14px;background:transparent;cursor:pointer;color:inherit}
.thinking-options button.selected{background:#2563eb;color:white}
.thinking-options button:disabled{opacity:.4;cursor:not-allowed}
.thinking-options button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
</style>
