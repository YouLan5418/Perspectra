<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  Boxes,
  Braces,
  BookUser,
  CalendarClock,
  ClipboardList,
  MapPin,
  Play,
  RefreshCw,
  Scale,
  SlidersHorizontal,
  Users,
  X,
} from '@lucide/vue'
import type { LensSection } from '../../../../desktop/lens/view.ts'
import { useLensStore, type LensViewName } from './store.ts'
import { SECTION_LABEL } from './format.ts'
import CharactersLens from './CharactersLens.vue'
import EventsLens from './EventsLens.vue'
import SimulationLens from './SimulationLens.vue'
import ItemsLens from './ItemsLens.vue'
import RequestsLens from './RequestsLens.vue'
import LensDetail from './LensDetail.vue'
import '../creator/creator.css'

/** 包透视：不开游戏看包的全部作者设置。左导航、主视图、右详情，样式沿用创作者控制台。 */
const props = defineProps<{ packageId: string }>()
const emit = defineEmits<{ close: [] }>()
const store = useLensStore()

const nav: { id: LensViewName; icon: unknown; label: string }[] = [
  { id: 'characters', icon: Users, label: SECTION_LABEL.characters },
  { id: 'events', icon: CalendarClock, label: SECTION_LABEL.events },
  { id: 'simulation', icon: Play, label: '回合推演' },
  { id: 'knowledge', icon: BookUser, label: SECTION_LABEL.knowledge },
  { id: 'places', icon: MapPin, label: SECTION_LABEL.places },
  { id: 'statuses', icon: Braces, label: SECTION_LABEL.statuses },
  { id: 'items', icon: Boxes, label: SECTION_LABEL.items },
  { id: 'rules', icon: Scale, label: SECTION_LABEL.rules },
  { id: 'presets', icon: SlidersHorizontal, label: SECTION_LABEL.presets },
  { id: 'requests', icon: ClipboardList, label: '待改清单' },
]
const isSection = (id: LensViewName): id is LensSection => id !== 'simulation' && id !== 'requests'
const badge = (id: LensViewName) =>
  id === 'requests' ? store.requestsOpenCount : isSection(id) ? store.changeCount(id) : 0

const snapshot = computed(() => store.snapshot)
const baselineLabel = computed(() => {
  const baseline = snapshot.value?.baseline
  if (!baseline || baseline.kind === 'none') return '还没有基准：点“已看过”后，之后的改动会在这里标出'
  return baseline.kind === 'seen' ? '上次“已看过”' : `对比点「${baseline.name}」`
})
const baselineChoice = computed({
  get: () => (snapshot.value?.baseline.kind === 'checkpoint' ? 'checkpoint:' + snapshot.value.baseline.name : 'seen'),
  set: value => {
    void store.setBaseline(
      value === 'seen' ? { kind: 'seen' } : { kind: 'checkpoint', name: value.slice('checkpoint:'.length) },
    )
  },
})
const checkpointName = ref('')
async function saveCheckpoint() {
  const name = checkpointName.value.trim()
  if (name && (await store.saveCheckpoint(name))) checkpointName.value = ''
}

async function close() {
  await store.close()
  emit('close')
}
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (store.selectedId) store.selectedId = ''
  else void close()
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void store.open(props.packageId)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="cr-root lens-window" role="dialog" aria-label="包透视">
    <div class="cr-body">
      <nav class="cr-nav lens-nav" aria-label="透视导航">
        <div class="cr-brand">
          <span class="cr-brand-text">
            <strong>包透视</strong><br />
            <small>只读，不开游戏</small>
          </span>
        </div>
        <div class="cr-nav-scroll">
          <button
            v-for="item in nav"
            :key="item.id"
            class="cr-nav-item"
            :class="{ active: store.view === item.id }"
            :title="item.label"
            @click="store.view = item.id"
          >
            <component :is="item.icon" :size="14" />
            <span class="cr-nav-label">{{ item.label }}</span>
            <span v-if="badge(item.id)" class="cr-nav-badge" :class="{ changed: item.id !== 'requests' }">
              {{ badge(item.id) }}
            </span>
          </button>
        </div>
      </nav>

      <div class="cr-main">
        <header class="cr-top">
          <div class="cr-top-row">
            <div class="cr-identity">
              <h1>{{ snapshot?.view.title ?? '正在读取世界包…' }}</h1>
              <span v-if="snapshot" class="cr-crumb">{{ snapshot.view.packId }} · {{ snapshot.view.packVersion }}</span>
            </div>
            <div class="cr-top-actions">
              <button
                class="cr-button"
                :disabled="store.busy || !snapshot"
                title="AI 改完包后，重新读取"
                @click="store.reload()"
              >
                <RefreshCw :size="13" />重新读取
              </button>
              <button class="cr-icon-button" aria-label="关闭透视" title="关闭透视" @click="close()">
                <X :size="16" />
              </button>
            </div>
          </div>
          <div v-if="snapshot" class="cr-top-row">
            <span class="cr-crumb">
              对比基准：<b>{{ baselineLabel }}</b>
              <template v-if="snapshot.changes.length"> · {{ snapshot.changes.length }} 处改动</template>
            </span>
            <div class="cr-top-actions">
              <label class="cr-field">
                基准
                <select v-model="baselineChoice" class="cr-select" :disabled="store.busy">
                  <option value="seen">上次“已看过”</option>
                  <option v-for="point in snapshot.checkpoints" :key="point.name" :value="'checkpoint:' + point.name">
                    对比点：{{ point.name }}
                  </option>
                </select>
              </label>
              <input
                v-model="checkpointName"
                class="cr-input lens-checkpoint"
                maxlength="40"
                placeholder="对比点名称"
                aria-label="对比点名称"
                @keydown.enter="saveCheckpoint()"
              />
              <button class="cr-button" :disabled="store.busy || !checkpointName.trim()" @click="saveCheckpoint()">
                存对比点
              </button>
              <button
                class="cr-button primary"
                :disabled="store.busy"
                title="把当前内容记为“已看过”；之后只标出新的改动"
                @click="store.markSeen()"
              >
                已看过
              </button>
            </div>
          </div>
        </header>
        <p v-if="!store.real" class="cr-banner warn">浏览器预览：显示固定样例，按钮不会真正读取或推演世界包。</p>
        <p v-if="store.error" class="cr-banner danger" role="alert">{{ store.error }}</p>
        <div class="cr-content">
          <p v-if="!snapshot" class="cr-empty cr-center">
            {{ store.busy ? '正在读取世界包并准备推演…' : '没有读到透视结果。' }}
          </p>
          <template v-else>
            <CharactersLens v-if="store.view === 'characters'" />
            <EventsLens v-else-if="store.view === 'events'" />
            <SimulationLens v-else-if="store.view === 'simulation'" />
            <RequestsLens v-else-if="store.view === 'requests'" />
            <ItemsLens v-else :section="store.view" />
            <LensDetail v-if="store.selected" />
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lens-window {
  position: absolute;
  inset: 40px 0 0;
  height: auto;
  z-index: 40;
}
.lens-nav {
  width: 188px;
}
.cr-nav-badge.changed {
  color: var(--cr-action);
}
.lens-checkpoint {
  width: 120px;
}
@media (max-width: 760px) {
  .lens-nav {
    width: 50px;
  }
  .lens-nav .cr-brand-text,
  .lens-nav .cr-nav-label,
  .lens-nav .cr-nav-badge {
    display: none;
  }
  .lens-nav .cr-nav-item {
    justify-content: center;
    padding: 0;
  }
}
</style>
