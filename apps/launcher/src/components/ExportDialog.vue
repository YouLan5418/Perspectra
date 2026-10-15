<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { chooseStoryDestination } from '../services/desktop.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
const props = defineProps<{ open: boolean; initialNodeId?: string }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const mode = ref<'current' | 'saved'>('saved')
const nodeId = ref(''), title = ref('分享节点'), error = ref(''), choosing = ref(false)
const canSaveCurrent = computed(() => store.core.state === 'running' && store.core.instanceId === store.selectedInstanceId)
const selectedNode = computed(() => store.currentHistory.find(node => node.id === nodeId.value))
const unavailable = computed(() => {
  if (!store.real) return '浏览器仅作界面预览；请启动桌面版导出真实存档。'
  if (store.currentInstance?.storyError) return store.currentInstance.storyError
  if (mode.value === 'current' && !canSaveCurrent.value) return '请先启动此实例，再保存当前进度并导出。'
  if (mode.value === 'saved' && !selectedNode.value) return '暂无可导出的完整节点。开始游戏后可保存当前进度并导出。'
  return ''
})
watch(() => props.open, open => {
  if (!open) return
  nodeId.value = props.initialNodeId || store.currentNode?.id || ''
  mode.value = props.initialNodeId || !canSaveCurrent.value ? 'saved' : 'current'
  title.value = '分享节点'
  error.value = ''
  store.notice = ''
})
async function save() {
  if (choosing.value || store.busy || unavailable.value) return
  choosing.value = true
  error.value = ''
  try {
    const path = await chooseStoryDestination()
    if (!path) return
    const ok = mode.value === 'current'
      ? await store.exportCurrentStory(title.value.trim(), path)
      : await store.exportStory(nodeId.value, path)
    if (ok) emit('close')
    else error.value = store.notice || '存档导出失败，请重试。'
  } catch { error.value = '导出路径选择失败，请重试。' }
  finally { choosing.value = false }
}
</script>
<template><DialogFrame :open="open" title="导出存档" description="分享一个可继续游玩的完整节点，保留当时的世界进度与角色记忆。" @close="emit('close')">
  <p class="muted">{{ store.selectedPackage?.title }} · {{ store.selectedPackage?.version }} / {{ store.currentStoryline?.name }}</p>
  <div class="form-field"><label for="export-story-mode">导出内容</label><select id="export-story-mode" v-model="mode" :disabled="store.busy || choosing"><option value="current" :disabled="!canSaveCurrent">保存当前进度并导出（需游戏运行中）</option><option value="saved">导出已保存节点</option></select></div>
  <template v-if="mode === 'current'">
    <div class="form-field"><label for="export-story-title">节点名称</label><input id="export-story-title" v-model="title" maxlength="80" :disabled="store.busy || choosing" /></div>
    <p class="muted">请先等待当前行动结束；保存会短暂冻结操作并取消未完成的后台记忆整理。导出后可以继续游玩。</p>
  </template>
  <template v-else>
    <div class="form-field"><label for="export-story-node">选择完整节点</label><select id="export-story-node" v-model="nodeId" :disabled="store.busy || choosing"><option v-for="node in store.currentHistory" :key="node.id" :value="node.id">时刻 {{ node.turn }} · {{ node.title }}</option></select></div>
    <p v-if="selectedNode" class="muted">{{ selectedNode.title }} · 时刻 {{ selectedNode.turn }} · {{ new Date(selectedNode.createdAt).toLocaleString('zh-CN') }}</p>
    <p class="muted">导出的是所选节点当时的进度，可能早于当前游玩进度；运行中也可导出。</p>
  </template>
  <p class="inline-info">文件包含截至节点的世界历史、角色私密状态、长期记忆和包变量，接收者能够查看这些内容。需要内容完全相同的游戏包，并使用对方自己的模型配置继续。</p>
  <p class="muted">仅导出所选节点，其他节点与线路不随文件传递。不携带游戏包、模型配置、密钥或请求记录。</p>
  <p v-if="unavailable" role="status">{{ unavailable }}</p>
  <p v-if="error" role="alert">{{ error }}</p><p v-if="store.notice && !error" role="status">{{ store.notice }}</p>
  <div class="dialog-actions"><Button variant="outline" :disabled="store.busy || choosing" @click="emit('close')">取消</Button><Button :disabled="!!unavailable || store.busy || choosing || (mode === 'current' && !title.trim())" @click="save">{{ store.busy ? '正在保存并导出…' : choosing ? '正在选择路径…' : '选择路径并导出' }}</Button></div>
</DialogFrame></template>
