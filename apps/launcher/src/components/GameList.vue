<script setup lang="ts">
import { ref } from 'vue'
import { ChevronsLeft, ChevronsRight, Library, Layers, Cpu, SlidersHorizontal, Settings } from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'
defineProps<{ activePanel: string | null }>()
defineEmits<{ model: []; preset: []; settings: [] }>()
const store = useLauncherStore()
const collapsed = ref(false)
</script>
<template>
  <aside class="game-sidebar" :class="{ collapsed }" aria-label="游戏列表">
    <div class="sidebar-brand"><a href="#" class="wordmark" aria-label="Perspectra 首页" @click.prevent><span class="brand-icon"><Layers :size="21" :stroke-width="1.8" /></span><span class="brand-name">Perspectra</span></a><button class="icon-button collapse-button" :aria-label="collapsed ? '展开侧栏' : '收起侧栏'" :title="collapsed ? '展开侧栏' : '收起侧栏'" @click="collapsed = !collapsed"><ChevronsRight v-if="collapsed" :size="16" /><ChevronsLeft v-else :size="16" /></button></div>
    <div class="sidebar-caption"><Library :size="16" /><span>我的游戏</span><span class="count">{{ store.packages.length }}</span></div>
    <nav class="game-list" aria-label="选择游戏">
      <button v-for="game in store.packages" :key="game.id" class="game-entry" :class="{ selected: game.id === store.selectedPackageId }" :aria-pressed="game.id === store.selectedPackageId" :aria-label="game.title" :title="collapsed ? game.title : undefined" :disabled="store.busy || store.core.state === 'running'" @click="store.selectPackage(game.id)">
        <span class="game-thumb" :class="game.artwork" aria-hidden="true"><span class="thumb-window"></span></span>
        <span class="game-entry-text"><strong>{{ game.title }}</strong><small>{{ game.validation.status === 'blocked' ? '需要检查' : store.instances.some(i => i.packageId === game.id && i.lastPlayedAt) ? '最近游玩' : '尚未开始' }}</small></span>
        <span v-if="game.id === store.selectedPackageId" class="selected-dot" aria-hidden="true"></span>
      </button>
      <p v-if="!store.packages.length" class="sidebar-empty">载入游戏包后，世界会出现在这里。</p>
    </nav>
    <nav class="sidebar-bottom" aria-label="工具与设置">
      <button class="sidebar-tool" :class="{ active: activePanel === 'model' }" :disabled="!store.currentInstance || store.busy || store.core.state === 'running'" title="当前实例模型配置" @click="$emit('model')"><Cpu :size="18" /><span>模型配置</span></button>
      <button class="sidebar-tool" :class="{ active: activePanel === 'preset' }" :disabled="!store.real || !store.currentInstance || store.busy || store.core.state === 'running'" title="角色预设与预设库" @click="$emit('preset')"><SlidersHorizontal :size="18" /><span>角色预设</span></button>
      <div class="sidebar-tool-divider"></div>
      <button class="sidebar-tool" :class="{ active: activePanel === 'settings' }" title="全局设置" @click="$emit('settings')"><Settings :size="18" /><span>全局设置</span></button>
      <span class="sidebar-footnote">本地世界，无限可能</span>
    </nav>
  </aside>
</template>
