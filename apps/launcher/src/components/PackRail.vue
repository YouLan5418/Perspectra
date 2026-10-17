<script setup lang="ts">
import { Plus } from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'

/** 左侧细图标栏：每个世界包一个小方图标，最下方载入新包；运行中整体变灰。 */
defineEmits<{ load: [] }>()
const store = useLauncherStore()
</script>

<template>
  <nav class="pack-rail" :class="{ locked: store.running }" aria-label="世界包">
    <button v-for="game in store.packages" :key="game.id" class="rail-pack" :class="[game.artwork, { selected: game.id === store.selectedPackageId }]"
      :aria-pressed="game.id === store.selectedPackageId" :aria-label="game.title"
      :title="store.running ? game.title + '（游戏运行中，结束后再切换）' : game.title"
      :disabled="store.busy || store.running" @click="store.selectPackage(game.id)">
      <img v-if="game.cover" :src="game.cover" alt="" />
      <span v-else aria-hidden="true">{{ game.title.slice(0, 1) }}</span>
    </button>
    <button class="rail-pack rail-add" aria-label="载入游戏包" title="载入游戏包"
      :disabled="store.busy || !store.initialized || store.running" @click="$emit('load')">
      <Plus :size="18" />
    </button>
  </nav>
</template>

<style scoped>
.pack-rail {
  position: absolute; left: 0; top: 40px; bottom: 0; width: 60px; z-index: 20;
  display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px 0; overflow-y: auto; scrollbar-width: none;
  background: rgba(14, 10, 12, 0.42); backdrop-filter: blur(14px) saturate(1.1); -webkit-backdrop-filter: blur(14px) saturate(1.1);
  border-right: 1px solid rgba(255, 255, 255, 0.08);
}
.rail-pack {
  flex: none; width: 40px; height: 40px; border-radius: 10px; padding: 0; overflow: hidden; cursor: pointer;
  display: grid; place-items: center; border: 0; background: var(--tone, rgba(255, 255, 255, 0.12));
  color: var(--stage-text); font-family: var(--font-display); font-size: 16px; font-weight: 700;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12); transition: transform 0.15s, box-shadow 0.15s, opacity 0.15s;
}
.rail-pack img { width: 100%; height: 100%; object-fit: cover; }
.rail-pack:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4); }
.rail-pack.selected { box-shadow: 0 0 0 2px var(--stage-text), 0 0 0 4px color-mix(in srgb, var(--lamp) 70%, transparent); }
.rail-add { background: transparent; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35); border-radius: 10px; }
.rail-add:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
.pack-rail.locked .rail-pack:not(.selected) { opacity: 0.4; filter: grayscale(0.7); }
.rail-pack:disabled { cursor: not-allowed; }
</style>
