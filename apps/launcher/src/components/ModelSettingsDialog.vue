<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { testModelConnection } from '../services/desktop.ts'
import type { ModelConnection } from '../core-types.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const protocolLabel = { openai: 'OpenAI 兼容', anthropic: 'Anthropic', google: 'Google Gemini' } as const
const placeholder = { openai: 'http://127.0.0.1:8046/v1/chat/completions', anthropic: 'https://api.anthropic.com/v1/messages', google: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent' } as const
/** Draft of the connection being edited; the key field stays empty unless the user types a new one. */
const editing = ref<string | null>(null)
const draft = reactive({ id: '', name: '', protocol: 'openai' as ModelConnection['protocol'], endpoint: '', apiKey: '', clearKey: false })
const expanded = ref<string | null>(null)
const pendingRemove = ref<string | null>(null)
const testModel = ref(''), testing = ref(false), testNotice = ref('')
watch(() => props.open, open => { if (!open) { editing.value = null; draft.apiKey = ''; pendingRemove.value = null; testNotice.value = '' } })
const users = (id: string) => store.realInstances.filter(i => [i.models?.decision, i.models?.memory, ...Object.values(i.models?.characters ?? {}).flatMap(c => [c.decision, c.memory])].some(t => t?.connectionId === id)).map(i => i.name)
const removing = computed(() => pendingRemove.value ? users(pendingRemove.value) : [])
const origin = (endpoint: string) => { try { return new URL(endpoint).origin } catch { return endpoint } }
const hostChanged = computed(() => { const saved = store.connections.find(c => c.id === draft.id); return !!saved && origin(saved.endpoint) !== origin(draft.endpoint.trim()) })
function startEdit(connection?: ModelConnection) {
  Object.assign(draft, connection ? { ...connection, apiKey: '', clearKey: false } : { id: crypto.randomUUID(), name: '', protocol: 'openai', endpoint: '', apiKey: '', clearKey: false })
  editing.value = draft.id; testNotice.value = ''; testModel.value = ''
}
async function save() {
  const connection: ModelConnection = { id: draft.id, name: draft.name.trim(), protocol: draft.protocol, endpoint: draft.endpoint.trim() }
  const key = draft.clearKey ? '' : draft.apiKey ? draft.apiKey : undefined
  if (!await store.saveConnection(connection, key)) return
  editing.value = null; draft.apiKey = ''
  expanded.value = connection.id
  void store.refreshModels(connection.id)
}
async function remove(id: string) {
  if (pendingRemove.value !== id && users(id).length) { pendingRemove.value = id; return }
  pendingRemove.value = null
  await store.removeConnection(id)
}
function toggle(id: string) {
  expanded.value = expanded.value === id ? null : id
  if (expanded.value && !store.modelLists[id]) void store.refreshModels(id)
}
async function test(id: string) {
  const model = testModel.value.trim() || store.modelLists[id]?.models[0]
  if (!model) { testNotice.value = '请先获取模型列表，或填写一个用于测试的模型。'; return }
  testing.value = true; testNotice.value = ''
  try { testNotice.value = await testModelConnection(id, model) }
  catch (error) { testNotice.value = typeof error === 'string' ? error : '模型连接测试失败。' }
  finally { testing.value = false }
}
</script>
<template><DialogFrame :open="open" wide title="模型设置" description="管理可用的模型连接。每条连接记住协议和接口地址，API Key 加密保存在 Windows 凭据管理器中；具体用哪个模型在各实例的“模型”里选择。" @close="emit('close')">
  <ul v-if="store.connections.length" class="connection-list">
    <li v-for="connection in store.connections" :key="connection.id" class="connection-item">
      <div class="connection-head">
        <div class="connection-copy">
          <strong>{{ connection.name }}</strong>
          <small>{{ protocolLabel[connection.protocol] }} · {{ connection.endpoint }}</small>
          <small>{{ store.storedKeys.has(connection.id) ? '已保存 API Key' : '未保存 API Key' }}</small>
        </div>
        <div class="connection-actions">
          <Button variant="outline" size="sm" @click="toggle(connection.id)">{{ expanded === connection.id ? '收起模型' : '查看模型' }}</Button>
          <Button variant="outline" size="sm" :disabled="store.busy" @click="startEdit(connection)">编辑</Button>
          <Button variant="outline" size="sm" :disabled="store.busy || store.core.state === 'running'" @click="remove(connection.id)">{{ pendingRemove === connection.id ? '确认删除' : '删除' }}</Button>
        </div>
      </div>
      <p v-if="pendingRemove === connection.id" class="inline-info">以下实例正在使用这条连接：{{ removing.join('、') }}。删除后需要在这些实例里重新选择模型。</p>
      <div v-if="expanded === connection.id" class="connection-models">
        <div class="connection-models-head">
          <small v-if="store.modelLists[connection.id]?.loading" class="muted">正在获取模型列表…</small>
          <small v-else-if="store.modelLists[connection.id]?.error" class="muted">{{ store.modelLists[connection.id]!.error }}</small>
          <small v-else class="muted">共 {{ store.modelLists[connection.id]?.models.length ?? 0 }} 个可用模型（这里只查看，在实例中选择）。</small>
          <Button variant="outline" size="sm" :disabled="store.modelLists[connection.id]?.loading" @click="store.refreshModels(connection.id)">刷新</Button>
        </div>
        <ul v-if="store.modelLists[connection.id]?.models.length" class="model-chips"><li v-for="model in store.modelLists[connection.id]!.models" :key="model">{{ model }}</li></ul>
        <div class="connection-test">
          <input v-model="testModel" :list="'test-' + connection.id" placeholder="测试用模型（默认列表第一个）" autocomplete="off" spellcheck="false" />
          <datalist :id="'test-' + connection.id"><option v-for="model in store.modelLists[connection.id]?.models ?? []" :key="model" :value="model" /></datalist>
          <Button variant="outline" size="sm" :disabled="!store.real || testing" @click="test(connection.id)">{{ testing ? '正在测试…' : '测试连接' }}</Button>
        </div>
        <small class="muted">测试会发送一次少量模型请求，不验证游戏所需的结构化输出。</small>
        <p v-if="testNotice" role="status">{{ testNotice }}</p>
      </div>
    </li>
  </ul>
  <p v-else class="inline-info">还没有模型连接。添加一条后，就能在实例里直接从列表选择模型。</p>

  <form v-if="editing" class="connection-form" @submit.prevent="save">
    <div class="form-field"><label for="connection-name">名称</label><input id="connection-name" v-model="draft.name" placeholder="例如：本地 8046 网关、DeepSeek 官方" maxlength="80" autocomplete="off" /></div>
    <div class="form-field"><label for="connection-protocol">接口协议</label><select id="connection-protocol" v-model="draft.protocol"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic Messages</option><option value="google">Google Gemini</option></select></div>
    <div class="form-field"><label for="connection-endpoint">接口地址</label><input id="connection-endpoint" v-model="draft.endpoint" :placeholder="placeholder[draft.protocol]" type="url" autocomplete="off" /></div>
    <p class="muted">填写完整请求地址：OpenAI 为 /v1/chat/completions；Anthropic 为 /v1/messages；Google 为 /v1beta/models/模型:generateContent。API Key 不放入地址。</p>
    <div class="form-field"><label for="connection-key">API Key</label>
      <input id="connection-key" v-model="draft.apiKey" type="password" :disabled="draft.clearKey" :placeholder="store.storedKeys.has(draft.id) ? '已保存；留空表示不修改' : '本地网关不需要可留空'" autocomplete="off" spellcheck="false" />
      <small v-if="hostChanged && store.storedKeys.has(draft.id) && !draft.apiKey" class="muted">接口主机已变化：保存后会清除原 API Key，如需要请重新填写。</small>
      <label v-if="store.storedKeys.has(draft.id)" class="checkbox-row"><input v-model="draft.clearKey" type="checkbox" />清除已保存的 API Key</label>
    </div>
    <div class="dialog-actions"><Button type="button" variant="outline" @click="editing = null">取消</Button><Button type="submit" :disabled="store.busy || !draft.name.trim() || !draft.endpoint.trim()">保存连接</Button></div>
  </form>
  <div v-else class="dialog-actions"><Button variant="outline" @click="emit('close')">关闭</Button><Button :disabled="store.busy" @click="startEdit()">添加连接</Button></div>
</DialogFrame></template>

<style scoped>
.connection-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; max-height: 46vh; overflow: auto; }
.connection-item { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; display: grid; gap: 10px; }
.connection-head { display: flex; gap: 12px; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; }
.connection-copy { display: grid; gap: 2px; min-width: 0; }
.connection-copy small { color: var(--muted-foreground); overflow-wrap: anywhere; }
.connection-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.connection-models { display: grid; gap: 8px; }
.connection-models-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.model-chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; max-height: 140px; overflow: auto; }
.model-chips li { font-size: 12px; padding: 3px 8px; border-radius: 999px; background: var(--muted); color: var(--foreground); }
.connection-test { display: flex; gap: 8px; }
.connection-test input { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; background: transparent; color: inherit; }
.connection-form { display: grid; gap: 12px; border-top: 1px solid var(--border); padding-top: 14px; }
.checkbox-row { display: flex; align-items: center; gap: 6px; font-weight: 400 !important; }
</style>
