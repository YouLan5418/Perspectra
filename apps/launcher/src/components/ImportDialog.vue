<script setup lang="ts">
import { ref, watch } from 'vue'
import { FolderOpen } from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { choosePackageDirectory, chooseStoryFile } from '../services/desktop.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
const props = defineProps<{ open: boolean; mode: 'package' | 'story' }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const path = ref(''), error = ref(''), name = ref('从朋友的故事继续')
watch(() => props.open, open => { if (open) { path.value = ''; error.value = ''; name.value = '从朋友的故事继续' } })
async function choose() {
  try { path.value = await (props.mode === 'story' ? chooseStoryFile() : choosePackageDirectory()) ?? '' }
  catch { error.value = '文件选择失败，请重试。' }
}
async function load() {
  const ok = props.mode === 'story' ? await store.importStory(path.value, name.value.trim()) : await store.loadRealPackage(path.value)
  if (ok) emit('close')
}
</script>
<template><DialogFrame :open="open" :title="mode === 'story' ? '导入故事线' : '载入游戏包'" :description="mode === 'story' ? '导入完整节点为新的独立实例；已有故事保持原样。' : '选择含 worldpack.source.json 的 v5 世界包目录。原包只读，实例独立保存。'" @close="emit('close')">
  <Button variant="outline" class="file-picker" :disabled="!store.real || store.busy" @click="choose"><FolderOpen :size="18" />{{ mode === 'story' ? '选择故事节点文件' : '选择世界包目录' }}</Button>
  <p v-if="path" class="muted">{{ path }}</p>
  <div v-if="mode === 'story'" class="form-field"><label for="import-story-name">新实例名称</label><input id="import-story-name" v-model="name" maxlength="80" /><p class="muted">对应游戏：{{ store.selectedPackage?.title }}。需要内容完全相同的游戏包；首次开始会重建角色记忆。</p></div>
  <p v-if="error" class="validation-issue" role="alert">{{ error }}</p>
  <p class="inline-info">{{ !store.real ? '浏览器仅作 Mock 预览；请启动桌面版操作真实文件。' : mode === 'story' ? '分享文件不携带游戏包与模型设置。你将使用本机模型配置继续。' : '载入时调用现有 Core 编译器校验世界与网页资源；选择世界包目录，不支持 ZIP。' }}</p>
  <p v-if="store.notice" role="status">{{ store.notice }}</p>
  <div class="dialog-actions"><Button variant="outline" @click="emit('close')">取消</Button><Button :disabled="!path || store.busy || (mode === 'story' && (!name.trim() || store.core.state === 'running'))" @click="load">{{ store.busy ? '正在校验…' : mode === 'story' ? '导入为新实例' : '校验并载入' }}</Button></div>
</DialogFrame></template>
