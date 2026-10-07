<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { createSharePreview } from '../domain.ts'
import type { ExportScope } from '../types.ts'
import { Button } from './ui/button/index.ts'
import DialogFrame from './DialogFrame.vue'
defineProps<{ open: boolean }>()
defineEmits<{ close: [] }>()
const store = useLauncherStore()
const scope = ref<ExportScope>('storyline')
const preview = computed(() => store.currentInstance && store.selectedPackage ? createSharePreview(store.currentInstance, store.selectedPackage, scope.value) : null)
const scopes: { id: ExportScope; title: string; description: string }[] = [
  { id: 'current-node', title: '当前节点', description: '让别人从这里继续' },
  { id: 'storyline', title: '当前完整故事线', description: '从起点到当前节点的历史' },
  { id: 'branch', title: '所选分支', description: '分享当前选中的一条线路' },
  { id: 'tree', title: '完整分支树', description: '分享这个实例的全部故事线' },
]
</script>
<template><DialogFrame :open="open" title="导出故事线" description="分享故事本身。对方使用自己的模型与本地配置继续。" @close="$emit('close')">
  <div class="export-options"><label v-for="option in scopes" :key="option.id" :class="{ active: scope === option.id }"><input v-model="scope" type="radio" name="scope" :value="option.id" /><span><strong>{{ option.title }}</strong><small>{{ option.description }}</small></span></label></div>
  <p class="muted">预览：{{ preview?.storylines.length }} 条故事线，{{ preview?.nodes.length }} 个示例历史节点。</p>
  <p class="inline-info">本阶段仅提供范围预览；真实存档导出尚未接入。导出边界排除密钥、认证、私人路径与本机设置。</p>
  <div class="dialog-actions"><Button @click="$emit('close')">完成</Button></div>
</DialogFrame></template>
