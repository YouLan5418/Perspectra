<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CreatorNav from './CreatorNav.vue'
import CreatorStatusBar from './CreatorStatusBar.vue'
import CreatorTopBar from './CreatorTopBar.vue'
import DetailPanel from './DetailPanel.vue'
import ActivitiesView from './ActivitiesView.vue'
import CharactersView from './CharactersView.vue'
import ConversationView from './ConversationView.vue'
import EntitiesView from './EntitiesView.vue'
import TraceView from './TraceView.vue'
import VariablesView from './VariablesView.vue'
import WorldView from './WorldView.vue'
import { useCreatorStore, POLL_MS } from './store.ts'
import './creator.css'

const props = defineProps<{ instanceId: string; gameTitle: string; storyline: string }>()
const emit = defineEmits<{ close: [] }>()
const store = useCreatorStore()

const views = { conversation: ConversationView, trace: TraceView, world: WorldView, characters: CharactersView, entities: EntitiesView, variables: VariablesView, activities: ActivitiesView }
const center = computed(() => views[store.view])
const scroller = ref<{ scrollToEnd?: () => void } | null>(null)
const candidateLabel = computed(() => {
  const current = store.candidate
  if (!current.ids.length && !current.id) return '未报告'
  const index = current.id ? current.ids.indexOf(current.id) + 1 : 0
  return index > 0 ? `${index}/${current.ids.length}` : `${current.ids.length} 个`
})

let timer: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  store.attach(props.instanceId)
  await store.load(true)
  timer = setInterval(() => { void store.poll() }, POLL_MS)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
watch(() => props.instanceId, async id => {
  store.attach(id)
  await store.load(true)
})
watch(() => store.follow, following => { if (following) scroller.value?.scrollToEnd?.() })

/* 详情面板宽度拖动；窄窗口下由样式改为覆盖式抽屉。 */
const dragging = ref(false)
function startDrag(event: PointerEvent) {
  dragging.value = true
  const startX = event.clientX, startWidth = store.detailWidth
  const move = (moveEvent: PointerEvent) => {
    store.detailWidth = Math.min(Math.max(280, startWidth - (moveEvent.clientX - startX)), Math.round(window.innerWidth * 0.7))
  }
  const stop = () => { dragging.value = false; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
}
function onKeydown(event: KeyboardEvent) { if (event.key === 'Escape' && store.detailOpen) store.closeDetail() }
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="cr-root">
    <div class="cr-body">
      <CreatorNav :game-title="gameTitle" :storyline="storyline" :candidate="candidateLabel" :preview="store.preview" />
      <div class="cr-main">
        <CreatorTopBar :game-title="gameTitle" :storyline="storyline" @close="emit('close')" />
        <p v-if="store.preview" class="cr-banner warn">浏览器预览：显示固定样例数据，未连接真实运行实例。在桌面 Launcher 中启动实例后读取真实快照。</p>
        <p v-if="store.error" class="cr-banner danger" role="alert">{{ store.error }}</p>
        <div class="cr-content">
          <component :is="center" ref="scroller" />
          <div v-if="store.detailOpen" class="cr-split" :class="{ dragging }" role="separator" aria-label="调整详情宽度" @pointerdown="startDrag" />
          <DetailPanel v-if="store.detailOpen" />
        </div>
        <CreatorStatusBar />
      </div>
    </div>
  </div>
</template>
