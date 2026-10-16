<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowLeft, ChevronDown, ChevronUp, RefreshCw, SlidersHorizontal } from '@lucide/vue'
import { KIND_LABEL } from './format.ts'
import { useCreatorStore } from './store.ts'
import type { StatusTone, TraceKind } from './types.ts'

const props = defineProps<{ gameTitle: string; storyline: string }>()
const emit = defineEmits<{ close: [] }>()
const store = useCreatorStore()

const candidateLabel = computed(() => {
  const current = store.candidate
  if (!current.ids.length && !current.id) return '未报告'
  const index = current.id ? current.ids.indexOf(current.id) + 1 : 0
  return index > 0 ? `${index}/${current.ids.length}` : `${current.ids.length} 个候选`
})

const kinds = Object.entries(KIND_LABEL) as [TraceKind, string][]
const tones: [StatusTone | '', string][] = [['', '全部状态'], ['ok', '通过／已提交'], ['warn', '需注意'], ['danger', '失败／被拒绝'], ['muted', '中性'], ['accent', '模型／表达']]

const search = ref(store.server.search)
let timer: ReturnType<typeof setTimeout> | undefined
watch(search, value => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { if (value !== store.server.search) void store.applyServer({ search: value.trim() }) }, 400)
})
watch(() => store.server.search, value => { if (value !== search.value) search.value = value })
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

const statusLabel = computed(() => {
  if (store.preview) return '浏览器预览'
  if (store.sourceBusy) return '本轮处理中'
  if (store.paused) return '已暂停'
  return '运行中'
})
const statusTone = computed(() => store.sourceBusy || store.paused ? 'warn' : 'ok')
const detailCount = computed(() => store.trace.length)
</script>

<template>
  <header class="cr-top">
    <div class="cr-top-row">
      <div class="cr-identity">
        <h1>{{ gameTitle }}</h1>
        <span class="cr-crumb">·</span>
        <span class="cr-crumb">{{ storyline }}</span>
        <span class="cr-crumb">· 当前候选 <b>{{ candidateLabel }}</b></span>
      </div>
      <div class="cr-top-actions">
        <span class="cr-tag" :class="statusTone"><i class="cr-dot" />{{ statusLabel }}</span>
        <span class="cr-tag line">采集 {{ store.captureEnabled ? '已开启' : '未开启' }}</span>
        <span class="cr-tag line">世界 v{{ store.world?.worldVersion ?? '—' }} · 序号 {{ store.world?.headSeq ?? 0 }} · tick {{ store.world?.tick ?? 0 }}</span>
        <button class="cr-button" @click="emit('close')"><ArrowLeft :size="13" />返回游戏库</button>
      </div>
    </div>

    <div class="cr-top-row">
      <div class="cr-tabs" role="tablist">
        <button class="cr-tab" role="tab" :aria-selected="store.view === 'conversation'" :class="{ active: store.view === 'conversation' }" @click="store.view = 'conversation'">对话</button>
        <button class="cr-tab" role="tab" :aria-selected="store.view === 'trace'" :class="{ active: store.view === 'trace' }" @click="store.view = 'trace'">轨迹 <span v-if="detailCount">· {{ detailCount }}</span></button>
      </div>
      <div class="cr-top-actions">
        <label class="cr-field">角色
          <select class="cr-select" :value="store.server.characterId" @change="store.applyServer({ characterId: ($event.target as HTMLSelectElement).value })">
            <option value="">全部角色</option>
            <option v-for="character in store.characters" :key="character.id" :value="character.id">{{ character.name }}</option>
          </select>
        </label>
        <label class="cr-field">物品
          <select class="cr-select" :value="store.server.entityId" @change="store.applyServer({ entityId: ($event.target as HTMLSelectElement).value })">
            <option value="">全部物品</option>
            <option v-for="entity in store.entities" :key="entity.id" :value="entity.id">{{ entity.name }}</option>
          </select>
        </label>
        <label class="cr-field">类型
          <select class="cr-select" :value="store.local.kinds[0] ?? ''" @change="store.setLocal({ kinds: ($event.target as HTMLSelectElement).value ? [($event.target as HTMLSelectElement).value as TraceKind] : [] })">
            <option value="">全部类型</option>
            <option v-for="[id, text] in kinds" :key="id" :value="id">{{ text }}</option>
          </select>
        </label>
        <label class="cr-field">状态
          <select class="cr-select" :value="store.local.tones[0] ?? ''" @change="store.setLocal({ tones: ($event.target as HTMLSelectElement).value ? [($event.target as HTMLSelectElement).value as StatusTone] : [] })">
            <option v-for="[id, text] in tones" :key="id" :value="id">{{ text }}</option>
          </select>
        </label>
        <label class="cr-field"><SlidersHorizontal :size="12" />
          <input v-model="search" class="cr-input" placeholder="搜索事件、行动、记录" aria-label="搜索事件、行动与记录">
        </label>
        <button class="cr-button" :class="{ primary: store.follow }" :aria-pressed="store.follow" @click="store.follow = !store.follow">
          <ChevronDown v-if="store.follow" :size="13" /><ChevronUp v-else :size="13" />{{ store.follow ? '跟随最新' : '已停止跟随' }}
        </button>
        <button class="cr-button" :class="{ primary: store.showProcess }" :aria-pressed="store.showProcess" @click="store.showProcess = !store.showProcess">
          显示处理过程
        </button>
        <button class="cr-button" :disabled="store.busy" @click="store.load(true)">
          <RefreshCw :size="13" :class="{ 'cr-loading': store.busy }" />刷新
        </button>
      </div>
    </div>
  </header>
</template>
