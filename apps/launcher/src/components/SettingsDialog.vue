<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
import { testModelConnection } from '../services/desktop.ts'
const testing=ref(false),testNotice=ref('')
async function testConnection(){
 testing.value=true;testNotice.value=''
 try{testNotice.value=await testModelConnection({model:draft.model,endpoint:draft.endpoint},draft.apiKey)}
 catch(error){testNotice.value=typeof error==='string'?error:'模型连接测试失败。'}
 finally{testing.value=false}
}
const draft = reactive({ model: '', endpoint: '', apiKey: '', largeText: false })

watch(() => props.open, open => {

  testNotice.value=''
  if (open) Object.assign(draft, { ...store.defaults, apiKey: store.providers[0]?.apiKey ?? '', largeText: store.largeText })
  else draft.apiKey = ''
})
async function save() {
  if (store.real) {
    if (!await store.saveSettings({ model: draft.model, endpoint: draft.endpoint }, draft.apiKey, draft.largeText)) return
  } else {
    store.providers = [{ id: 'local', label: 'OpenAI 兼容接口', endpoint: draft.endpoint, apiKey: draft.apiKey }]
    store.notice = '浏览器展示为 Mock；真实运行请使用 Tauri 桌面。'
  }
  store.largeText = draft.largeText
  emit('close')
}
</script>
<template><DialogFrame :open="open" title="设置" description="本轮使用 OpenAI 兼容接口与 Core 记忆。API Key 只保留于本次会话，绑定此接口地址。" @close="emit('close')">
  <div class="form-field"><label for="endpoint">接口地址</label><input id="endpoint" v-model="draft.endpoint" placeholder="http://127.0.0.1:8046/v1/chat/completions" type="url" autocomplete="off" :disabled="store.busy" /></div>
  <div class="form-field"><label for="api-key">API Key</label><input id="api-key" v-model="draft.apiKey" type="password" placeholder="仅在本次会话内保留" autocomplete="off" spellcheck="false" /></div>
  <div class="form-field"><label for="global-model">新实例默认模型标识</label><input id="global-model" v-model="draft.model" autocomplete="off" /></div>
  <div class="form-field"><label for="data-directory">实例数据目录</label><input id="data-directory" :value="store.dataDirectory" readonly /></div>
  <p class="muted">更改默认配置只影响新实例；现有实例在“模型”中单独修改。退出 Launcher 会结束运行中的游戏。</p>
  <label class="checkbox-row"><input v-model="draft.largeText" type="checkbox" />使用较大文字</label>
  <div class="connection-row"><Button variant="outline" :disabled="!store.real || store.busy || testing" @click="testConnection">{{ testing ? '正在测试…' : '测试模型连接' }}</Button><small>会发送一次少量模型请求。</small></div>
  <p v-if="testNotice" role="status">{{ testNotice }}</p>
  <div class="dialog-actions"><Button variant="outline" @click="emit('close')">取消</Button><Button :disabled="store.busy || store.core.state === 'running'" @click="save">应用设置</Button></div>
</DialogFrame></template>
