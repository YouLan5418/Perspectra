<script setup lang="ts">
import { ref, watch } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { chooseStoryDestination } from '../services/desktop.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const nodeId = ref(''), error = ref('')
watch(() => props.open, open => { if (open) { nodeId.value = store.currentNode?.id ?? ''; error.value = '' } })
async function save() {
  try {
    const path = await chooseStoryDestination()
    if (path && await store.exportStory(nodeId.value, path)) emit('close')
  } catch { error.value = '导出路径选择失败，请重试。' }
}
</script>
<template><DialogFrame :open="open" title="导出故事节点" description="让接收者从一个完整时刻继续。需要相同游戏包，角色记忆会重新整理。" @close="emit('close')">
  <div class="form-field"><label for="export-story-node">选择完整节点</label><select id="export-story-node" v-model="nodeId"><option v-for="node in store.currentHistory" :key="node.id" :value="node.id">时刻 {{ node.turn }} · {{ node.title }}</option></select></div>
  <p class="inline-info">文件包含截至节点的世界历史、角色私密状态和包变量，接收者能够查看这些内容。仅分享你愿意交给对方的存档。</p>
  <p class="muted">仅导出所选节点，其他节点与线路不随文件传递。不携带游戏包、模型配置、密钥或请求记录。</p>
  <p v-if="error" role="alert">{{ error }}</p><p v-if="store.notice" role="status">{{ store.notice }}</p>
  <div class="dialog-actions"><Button variant="outline" @click="emit('close')">取消</Button><Button :disabled="!store.real || store.busy || store.core.state === 'running' || !nodeId || !!store.currentInstance?.storyError" @click="save">选择路径并导出</Button></div>
</DialogFrame></template>
