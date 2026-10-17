<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { X } from '@lucide/vue'
import { useLauncherStore } from '../stores/launcher.ts'
import TitleBar from './TitleBar.vue'
import PackRail from './PackRail.vue'
import HomeStage from './HomeStage.vue'
import ModelConfigDialog from './ModelConfigDialog.vue'
import StorylineDialog from './StorylineDialog.vue'
import ImportDialog from './ImportDialog.vue'
import ExportDialog from './ExportDialog.vue'
import SettingsDialog from './SettingsDialog.vue'
import ModelSettingsDialog from './ModelSettingsDialog.vue'
import PresetDialog from './PresetDialog.vue'

const store = useLauncherStore()
watch(() => store.theme, theme => { document.documentElement.dataset.theme = theme }, { immediate: true })
watch(() => store.palette, palette => { document.documentElement.dataset.palette = palette }, { immediate: true })

let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(() => store.notice, text => {
  if (noticeTimer) {
    clearTimeout(noticeTimer)
    noticeTimer = undefined
  }
  if (text) {
    noticeTimer = setTimeout(() => {
      store.notice = ''
      noticeTimer = undefined
    }, 3200)
  }
})

let poll: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  await store.initialize()
  poll = setInterval(() => { void store.refresh() }, 2500)
})
onUnmounted(() => {
  clearInterval(poll)
  if (noticeTimer) clearTimeout(noticeTimer)
})
const panel = ref<'model' | 'model-settings' | 'story' | 'import' | 'export' | 'settings' | 'package' | 'preset' | null>(null)
const exportNodeId = ref('')
/** 主屏状态标签与“⋯”打开本局设置；抽屉接入前暂由原对话框承接。 */
function openDrawer(section?: 'model' | 'frontend' | 'story') {
  panel.value = section === 'model' ? 'model' : 'story'
}
function showExport(nodeId = '') {
  exportNodeId.value = nodeId
  panel.value = 'export'
}
</script>

<template>
  <div class="launcher" :class="{ 'large-text': store.largeText }">
    <HomeStage @open-drawer="openDrawer" @load="panel = 'package'" />
    <PackRail @load="panel = 'package'" />
    <TitleBar @open-settings="panel = 'settings'" />
    <Transition name="notice-fade">
      <div v-if="store.notice && panel !== 'export'" class="notice" role="status">
        <span>{{ store.notice }}</span>
        <button class="icon-button" aria-label="关闭提示" @click="store.notice = ''"><X :size="15" /></button>
      </div>
    </Transition>
    <p v-if="store.core.state === 'error'" class="notice" role="alert">{{ store.core.message }}</p>
    <ModelConfigDialog :open="panel === 'model'" @close="panel = null" />
    <StorylineDialog :open="panel === 'story'" @close="panel = null" @import="panel = 'import'" @export="showExport" />
    <ImportDialog :open="panel === 'import' || panel === 'package'" :mode="panel === 'package' ? 'package' : 'story'" @close="panel = null" />
    <ExportDialog :open="panel === 'export'" :initial-node-id="exportNodeId" @close="panel = null" />
    <PresetDialog :open="panel === 'preset'" @close="panel = null" />
    <ModelSettingsDialog :open="panel === 'model-settings'" @close="panel = null" />
    <SettingsDialog :open="panel === 'settings'" @close="panel = null" />
  </div>
</template>
