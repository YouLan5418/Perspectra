<script setup lang="ts">
import { Plus, ChevronRight, Library } from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'
import { Button } from './ui/button/index.ts'
defineEmits<{ load: [] }>()
const store = useLauncherStore()
</script>
<template>
  <aside class="game-sidebar" aria-label="游戏列表">
    <div class="sidebar-caption"><Library :size="15" /><span>我的游戏</span><span class="count">{{ store.packages.length }}</span></div>
    <div class="section-label">最近游玩</div>
    <div class="game-list">
      <button v-for="game in store.packages" :key="game.id" class="game-entry" :class="{ selected: game.id === store.selectedPackageId }" :aria-pressed="game.id === store.selectedPackageId" :disabled="store.busy || store.core.state === 'running'" @click="store.selectPackage(game.id)">
        <span class="game-thumb" :class="game.artwork"><span class="thumb-window"></span></span>
        <span class="game-entry-text"><strong>{{ game.title }}</strong><small>{{ game.validation.status === 'blocked' ? '需要检查游戏包' : store.instances.some(i => i.packageId === game.id && i.lastPlayedAt) ? store.real ? '最近游玩' : '最近游玩 · 示例' : '尚未开始' }}</small></span>
        <ChevronRight v-if="game.id === store.selectedPackageId" :size="15" />
      </button>
    </div>
    <div class="sidebar-bottom"><p>每一次选择，<br />都是另一种可能。</p><Button variant="outline" class="load-button" :disabled="store.busy || !store.initialized || store.core.state === 'running'" @click="$emit('load')"><Plus :size="16" />载入游戏包</Button><span class="sidebar-footnote">本地游戏 · 你的故事</span></div>
  </aside>
</template>
