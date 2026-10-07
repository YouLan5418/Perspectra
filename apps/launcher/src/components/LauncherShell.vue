<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { Settings, Layers, Circle, X } from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'
import GameList from './GameList.vue'
import GameDetail from './GameDetail.vue'
import ModelConfigDialog from './ModelConfigDialog.vue'
import StorylineDialog from './StorylineDialog.vue'
import ImportDialog from './ImportDialog.vue'
import ExportDialog from './ExportDialog.vue'
import SettingsDialog from './SettingsDialog.vue'
const store = useLauncherStore()
let poll: ReturnType<typeof setInterval> | undefined
onMounted(async () => { await store.initialize(); poll = setInterval(() => { void store.refresh() }, 2500) })
onUnmounted(() => clearInterval(poll))
const panel = ref<'model' | 'story' | 'import' | 'export' | 'settings' | 'package' | null>(null)
</script>

<template>
  <div class="launcher" :class="{ 'large-text': store.largeText }">
    <header class="topbar">
      <a href="#" class="wordmark" aria-label="Perspectra 首页" @click.prevent="panel = null"><Layers :size="22" :stroke-width="1.7" />Perspectra<span>LAUNCHER</span></a>
      <div class="header-right"><span class="prototype-label">{{ store.real ? '真实 Core · 本机运行' : 'Mock 浏览器预览' }}</span><button class="icon-button" aria-label="全局设置" title="设置" @click="panel = 'settings'"><Settings :size="19" /></button></div>
    </header>
    <div class="workspace">
      <GameList @load="panel = 'package'" />
      <GameDetail @model="panel = 'model'" @story="panel = 'story'" @import="panel = 'import'" @export="panel = 'export'" @settings="panel = 'settings'" />
    </div>
    <footer class="statusbar">
      <span><Circle :size="7" fill="currentColor" />{{ store.busy ? '正在处理…' : store.core.state === 'running' ? 'Core 运行中' : store.core.state === 'error' ? 'Core 异常' : 'Core 待启动' }}{{ store.real ? '' : '（模拟）' }}</span>
      <span>数据：{{ store.real ? '独立实例目录' : '内存示例' }}</span><span>模型：{{ store.real ? 'Core 记忆已选用' : '示例配置，未连接' }}</span><span class="version">Perspectra 0.1.0</span>
    </footer>
    <div v-if="store.notice" class="notice" role="status"><span>{{ store.notice }}</span><button class="icon-button" aria-label="关闭提示" @click="store.notice = ''"><X :size="15" /></button></div>
    <p v-if="store.core.state === 'error'" class="notice" role="alert">{{ store.core.message }}</p>
    <ModelConfigDialog :open="panel === 'model'" @close="panel = null" />
    <StorylineDialog :open="panel === 'story'" @close="panel = null" />
    <ImportDialog :open="panel === 'import' || panel === 'package'" :mode="panel === 'package' ? 'package' : 'story'" @close="panel = null" />
    <ExportDialog :open="panel === 'export'" @close="panel = null" />
    <SettingsDialog :open="panel === 'settings'" @close="panel = null" />
  </div>
</template>
