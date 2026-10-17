<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Plus, X } from '@lucide/vue'
import { useLauncherStore, type DrawerSection } from '../stores/launcher.ts'
import StorylineDialog from './StorylineDialog.vue'
import ImportDialog from './ImportDialog.vue'
import ExportDialog from './ExportDialog.vue'
import ModelConfigDialog from './ModelConfigDialog.vue'
import PresetDialog from './PresetDialog.vue'
import FrontendAuthorizationDialog from './FrontendAuthorizationDialog.vue'
import PlaySettingsDialog from './PlaySettingsDialog.vue'

/** 本局抽屉：一列设置行，点进去在抽屉内部翻页；原对话框在这里只渲染内容。 */
type Page = Exclude<DrawerSection, 'creator'> | 'import' | 'export'
const props = defineProps<{ open: boolean; section: DrawerSection | null }>()
const emit = defineEmits<{ close: [] }>()
provide('launcher-embedded', true)
const store = useLauncherStore()
const page = ref<Page | null>(null)
const exportNodeId = ref('')
/** 有未保存草稿的页面在这里登记检查函数；返回或关闭前先确认。 */
const dirtyCheck = { current: null as null | (() => boolean) }
provide('launcher-dirty', dirtyCheck)
function leave(): boolean { return !dirtyCheck.current?.() || confirm('有未保存的修改，确定离开？') }
const groups = computed(() => (['游玩', '进阶'] as const).map(group => ({ group, rows: store.drawerRows.filter(row => row.group === group) })))

watch(() => [props.open, props.section] as const, ([open, section]) => {
  if (open) page.value = section && section !== 'creator' ? section : null
}, { immediate: true })
function choose(id: DrawerSection) {
  if (id === 'creator') { void store.openCreator(); return }
  page.value = id
}
function back() { if (!leave()) return; page.value = page.value === 'import' || page.value === 'export' ? 'story' : null }
function close() { if (leave()) emit('close') }
// 详情页里的草稿属于打开时的实例；实例或包一变就回到首页，避免把 A 的草稿存进 B。
watch(() => [store.selectedInstanceId, store.selectedPackageId], () => { page.value = null })
const runningNotice = computed(() => !store.running || page.value === 'frontend' ? ''
  : page.value === 'story' || page.value === 'import' || page.value === 'export' ? '游戏运行中：可以浏览和导出存档，切换故事线与导入需先结束游戏'
  : '修改将在下次启动游戏时生效')
function showExport(nodeId = '') { exportNodeId.value = nodeId; page.value = 'export' }
function onKey(event: KeyboardEvent) { if (event.key === 'Escape' && props.open && !page.value && !document.querySelector('.settings-window')) emit('close') }
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
const shown = (name: Page) => props.open && page.value === name
</script>

<template>
  <Transition name="drawer">
    <div v-if="open" class="drawer-scrim" @click.self="close">
      <aside class="session-drawer" aria-label="本局设置">
        <header class="drawer-head">
          <button v-if="page" class="drawer-icon" aria-label="返回" @click="back"><ChevronLeft :size="18" /></button>
          <div class="drawer-title">
            <strong>{{ store.selectedPackage?.title ?? '本局设置' }}</strong>
            <div class="drawer-instance">
              <select v-model="store.selectedInstanceId" aria-label="游玩实例" :disabled="store.running || store.busy || Boolean(page)">
                <option v-for="instance in store.gameInstances" :key="instance.id" :value="instance.id">{{ instance.name }}</option>
              </select>
              <button class="drawer-link" :disabled="store.running || store.busy" @click="store.newInstance('第 ' + (store.gameInstances.length + 1) + ' 次游玩')"><Plus :size="13" />新建实例</button>
            </div>
          </div>
          <button class="drawer-icon" aria-label="关闭本局设置" @click="close"><X :size="18" /></button>
        </header>
        <p v-if="runningNotice" class="drawer-running" role="status">{{ runningNotice }}</p>

        <div class="drawer-body">
          <template v-if="!page">
            <section v-for="{ group, rows } in groups" :key="group" class="drawer-group">
              <h3>{{ group }}</h3>
              <button v-for="row in rows" :key="row.id" class="drawer-row" :class="{ warn: row.warn }" :disabled="row.disabled" @click="choose(row.id)">
                <span class="drawer-row-label">{{ row.label }}</span>
                <span class="drawer-row-summary">{{ row.summary }}</span>
                <span class="drawer-row-action">{{ row.action }}<ChevronRight :size="14" /></span>
              </button>
            </section>
          </template>
          <StorylineDialog :open="shown('story')" @close="back" @import="page = 'import'" @export="showExport" />
          <ImportDialog :open="shown('import')" mode="story" @close="back" />
          <ExportDialog :open="shown('export')" :initial-node-id="exportNodeId" @close="back" />
          <ModelConfigDialog :open="shown('model')" @close="back" />
          <PresetDialog :open="shown('preset')" @close="back" />
          <FrontendAuthorizationDialog :open="shown('frontend')" @close="back" />
          <PlaySettingsDialog :open="shown('play')" @close="back" />
        </div>
      </aside>
    </div>
  </Transition>
</template>

<style scoped>
.drawer-scrim { position: absolute; inset: 40px 0 0 60px; z-index: 40; }
.session-drawer {
  --drawer-bg: rgba(255, 255, 255, 0.62); --drawer-line: rgba(255, 255, 255, 0.7); --drawer-row: rgba(255, 255, 255, 0.45);
  position: absolute; top: 0; right: 0; bottom: 0; width: max(380px, 44%); max-width: 100%;
  display: flex; flex-direction: column; color: var(--pal-l-text); color-scheme: light;
  --foreground: var(--pal-l-text); --muted-foreground: var(--pal-l-mfg); --border: rgba(80, 60, 70, 0.16); --background: rgba(255, 255, 255, 0.7);
  background: var(--drawer-bg); backdrop-filter: blur(22px) saturate(1.25); -webkit-backdrop-filter: blur(22px) saturate(1.25);
  border-left: 1px solid var(--drawer-line); box-shadow: -10px 0 30px rgba(0, 0, 0, 0.14);
}
:root[data-theme="dark"] .session-drawer {
  --drawer-bg: rgba(24, 20, 23, 0.6); --drawer-line: rgba(255, 255, 255, 0.12); --drawer-row: rgba(255, 255, 255, 0.06);
  color: var(--pal-d-text); color-scheme: dark; --foreground: var(--pal-d-text); --muted-foreground: var(--pal-d-mfg); --border: rgba(255, 255, 255, 0.12); --background: rgba(30, 26, 29, 0.7);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .session-drawer {
    --drawer-bg: rgba(24, 20, 23, 0.6); --drawer-line: rgba(255, 255, 255, 0.12); --drawer-row: rgba(255, 255, 255, 0.06);
    color: var(--pal-d-text); color-scheme: dark; --foreground: var(--pal-d-text); --muted-foreground: var(--pal-d-mfg); --border: rgba(255, 255, 255, 0.12); --background: rgba(30, 26, 29, 0.7);
  }
}
.drawer-head { display: flex; align-items: flex-start; gap: 8px; padding: 16px 16px 10px; }
.drawer-title { flex: 1; min-width: 0; display: grid; gap: 6px; }
.drawer-title strong { font-family: var(--font-display); font-size: 18px; }
.drawer-instance { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.drawer-instance select { border: 1px solid var(--border); background: var(--background); color: inherit; border-radius: 7px; padding: 4px 8px; font-size: 12.5px; }
.drawer-link { display: inline-flex; align-items: center; gap: 3px; border: 0; background: none; color: var(--primary); font-size: 12.5px; cursor: pointer; }
.drawer-icon { border: 0; background: transparent; color: inherit; width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; cursor: pointer; }
.drawer-icon:hover { background: var(--drawer-row); }
.drawer-running { margin: 0 16px 6px; padding: 7px 12px; border-radius: 8px; font-size: 12.5px; background: color-mix(in srgb, var(--warning) 18%, transparent); }
.drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 16px 20px; display: grid; gap: 14px; align-content: start; }
.drawer-group h3 { margin: 6px 0 6px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.12em; color: var(--muted-foreground); }
.drawer-row {
  width: 100%; display: grid; grid-template-columns: 84px 1fr auto; align-items: center; gap: 10px; text-align: left; cursor: pointer;
  padding: 11px 12px; margin-bottom: 6px; border-radius: 10px; border: 1px solid var(--drawer-line); background: var(--drawer-row); color: inherit; font-size: 13.5px;
}
.drawer-row:hover:not(:disabled) { background: color-mix(in srgb, var(--drawer-row) 60%, var(--drawer-line)); }
.drawer-row:disabled { opacity: 0.55; cursor: not-allowed; }
.drawer-row.warn { background: rgba(255, 196, 140, 0.4); border-color: rgba(230, 150, 80, 0.45); }
.drawer-row-label { font-weight: 650; }
.drawer-row-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground); font-size: 12.5px; }
.drawer-row-action { display: inline-flex; align-items: center; gap: 2px; color: var(--primary); font-size: 12.5px; white-space: nowrap; }
.drawer-enter-active, .drawer-leave-active { transition: opacity 0.2s ease; }
.drawer-enter-active .session-drawer, .drawer-leave-active .session-drawer { transition: transform 0.24s cubic-bezier(0.16, 1, 0.3, 1); }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-enter-from .session-drawer, .drawer-leave-to .session-drawer { transform: translateX(40px); }
</style>
