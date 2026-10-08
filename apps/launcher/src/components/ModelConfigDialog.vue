<script setup lang="ts">
import { reactive, watch } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const draft = reactive({ protocol: 'openai' as 'openai' | 'anthropic' | 'google', model: '', endpoint: '' })
watch(() => props.open, open => { if (open) Object.assign(draft, { ...store.currentRealModel, protocol: store.currentRealModel.protocol ?? 'openai' }) })
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
  <p class="inline-info">角色独立映射暂未接入。认证在全局设置填写，仅保留在本次会话。</p>
  <div class="dialog-actions"><Button variant="outline" @click="emit('close')">取消</Button><Button :disabled="store.busy || store.core.state === 'running'" @click="save">保存配置</Button></div>
</DialogFrame></template>
