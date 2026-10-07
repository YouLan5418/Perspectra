<script setup lang="ts">
import { ref, watch } from 'vue'
import { FolderOpen } from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { choosePackageDirectory } from '../services/desktop.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
const props = defineProps<{ open: boolean; mode: 'package' | 'story' }>()
const emit = defineEmits<{ close: [] }>()
const store = useLauncherStore()
const path = ref('')
const error = ref('')
watch(() => props.open, open => { if (open) { path.value = ''; error.value = '' } })
async function choose() {
  try { path.value = await choosePackageDirectory() ?? '' }
  catch { error.value = '目录选择失败，请重试。' }
}
async function load() { if (await store.loadRealPackage(path.value)) emit('close') }
</script>
<template><DialogFrame :open="open" title="载入游戏包" description="选择含 worldpack.source.json 的 v5 世界包目录。原包只读，实例独立保存。" @close="emit('close')">
  <Button variant="outline" class="file-picker" :disabled="!store.real || store.busy" @click="choose"><FolderOpen :size="18" />选择世界包目录</Button>
  <p v-if="path" class="muted">{{ path }}</p>
  <p v-if="error" class="validation-issue" role="alert">{{ error }}</p>
  <p class="inline-info">{{ store.real ? '载入时调用现有 Core 编译器校验世界与网页资源。首轮不支持 ZIP 或故事线分享文件。' : '浏览器仅作 Mock 预览；请启动 Tauri 桌面以载入真实包。' }}</p>
  <div class="dialog-actions"><Button variant="outline" @click="emit('close')">取消</Button><Button :disabled="!path || store.busy" @click="load">{{ store.busy ? '正在校验…' : '校验并载入' }}</Button></div>
</DialogFrame></template>
