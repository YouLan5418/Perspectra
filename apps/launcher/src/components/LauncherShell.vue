<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { X } from '@lucide/vue'
import { useLauncherStore, type DrawerSection } from '../stores/launcher.ts'
import TitleBar from './TitleBar.vue'
import PackRail from './PackRail.vue'
import HomeStage from './HomeStage.vue'
import ImportDialog from './ImportDialog.vue'
import SessionDrawer from './SessionDrawer.vue'
import SettingsWindow from './SettingsWindow.vue'

const store = useLauncherStore()
watch(
  () => store.theme,
  theme => {
    document.documentElement.dataset.theme = theme
  },
  { immediate: true },
)

let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => store.notice,
  text => {
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
  },
)

let poll: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  await store.initialize()
  poll = setInterval(() => {
    void store.refresh()
  }, 2500)
})
onUnmounted(() => {
  clearInterval(poll)
  if (noticeTimer) clearTimeout(noticeTimer)
})
const panel = ref<'settings' | 'package' | null>(null)
/** 主屏状态标签直达对应行；“⋯”打开抽屉首页。 */
const drawer = ref<{ open: boolean; section: DrawerSection | null }>({ open: false, section: null })
function openDrawer(section?: DrawerSection) {
  drawer.value = { open: true, section: section ?? null }
}
</script>

<template>
  <div class="launcher" :class="{ 'large-text': store.largeText }">
    <HomeStage @open-drawer="openDrawer" @load="panel = 'package'" />
    <PackRail @load="panel = 'package'" />
    <TitleBar @open-settings="panel = 'settings'" />
    <Transition name="notice-fade">
      <div v-if="store.notice" class="notice" role="status">
        <span>{{ store.notice }}</span>
        <button class="icon-button" aria-label="关闭提示" @click="store.notice = ''"><X :size="15" /></button>
      </div>
    </Transition>
    <p v-if="store.core.state === 'error'" class="notice" role="alert">{{ store.core.message }}</p>
    <SessionDrawer :open="drawer.open" :section="drawer.section" @close="drawer.open = false" />
    <ImportDialog :open="panel === 'package'" mode="package" @close="panel = null" />
    <SettingsWindow v-if="panel === 'settings'" @close="panel = null" />
  </div>
</template>
