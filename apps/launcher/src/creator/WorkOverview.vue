<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ImagePlus, ArrowRight, ChevronRight, MapPin, Users, Box, Play } from '@lucide/vue'
import { editorRequest } from './editor-api.ts'
import type { worldRecords } from '../../../host/src/editor/world-records.ts'
import type { stageArtPreview } from '../../../host/src/editor/stage-art.ts'
const props = defineProps<{ book: ReturnType<typeof worldRecords> }>()
const emit = defineEmits<{
  activity: [key?: string]
  script: [key: string]
  opening: []
  slot: [id: string]
  records: [kind: 'character' | 'location' | 'item']
}>()
const indexes = [
  { kind: 'location', name: '地点', icon: MapPin },
  { kind: 'character', name: '角色', icon: Users },
  { kind: 'item', name: '物品', icon: Box },
] as const
const data = ref<{
  version: string
  activities: { key: string; title: string; count: number }[]
  scripts: string[]
  cover: string | null
}>()
const image = ref<ReturnType<typeof stageArtPreview>>(),
  error = ref(''),
  pending = ref(true)
const slots = computed(() =>
  props.book.records
    .filter(r => r.kind === 'slot')
    .map(s => {
      const actor = props.book.records.find(r => r.kind === 'character' && r.id === s.values.characterId)
      const place = props.book.records.find(r => r.kind === 'location' && r.id === actor?.values.initialLocationId)
      return { ...s, location: place?.name ?? '初始地点未指定' }
    }),
)
async function reload() {
  data.value = await editorRequest('overview')
  image.value = data.value?.cover ? await editorRequest('stage-art-preview', { path: data.value.cover }) : undefined
}
onMounted(async () => {
  try {
    await reload()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    pending.value = false
  }
})
const uploading = ref(false)
defineExpose({
  flush() {
    if (uploading.value) throw Error('请等封面写入完成')
  },
})
async function cover(e: Event) {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0]
  if (!file) return
  uploading.value = true
  pending.value = true
  error.value = ''
  try {
    if (file.size > 4 * 1024 * 1024) throw Error('封面最大 4 MiB')
    const reader = new FileReader()
    const encoded = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result).split(',')[1]!)
      reader.onerror = () => reject(Error('读取图片失败'))
      reader.readAsDataURL(file)
    })
    await editorRequest('stage-art-import', { kind: 'cover', base: image.value?.base ?? null, base64: encoded })
    await reload()
  } catch (e) {
    error.value = (e as Error).message
    await reload().catch(() => {})
  } finally {
    pending.value = false
    uploading.value = false
    input.value = ''
  }
}
</script>
<template>
  <section class="overview" aria-label="作品总览">
    <div class="overview-body">
      <header class="work-identity">
        <div class="work-title">
          <p class="section-label">作品总览</p>
          <h1>{{ book.title }}</h1>
          <p class="metadata">
            <span>{{ book.packId }}</span
            ><span v-if="data">v{{ data.version }}</span>
          </p>
        </div>
        <label class="cover" :class="{ empty: !image }">
          <img v-if="image" :src="image.data" :alt="book.title + '的封面'" />
          <span><ImagePlus :size="17" aria-hidden="true" />{{ image ? '更改封面' : '添加封面' }}</span>
          <input
            type="file"
            :aria-label="image ? '更改封面' : '添加封面'"
            :disabled="pending"
            accept="image/png,image/webp,image/jpeg"
            @change="cover"
          />
        </label>
      </header>
      <slot />
      <p v-if="error" role="alert">{{ error }}</p>
      <div class="summary">
        <section class="opening">
          <h2>玩家开局</h2>
          <button v-for="s in slots" :key="s.id" class="slot-row" @click="emit('slot', s.id)">
            <strong>{{ s.name }}</strong>
            <span><MapPin :size="14" aria-hidden="true" />{{ s.location }}</span>
            <ChevronRight :size="16" aria-hidden="true" />
          </button>
          <button class="text-action" @click="emit('opening')">
            <Play :size="13" aria-hidden="true" />试玩这个开局
          </button>
        </section>
        <section class="content-index">
          <h2>作品内容</h2>
          <div class="indexes">
            <button v-for="entry in indexes" :key="entry.kind" @click="emit('records', entry.kind)">
              <span><component :is="entry.icon" :size="15" aria-hidden="true" />{{ entry.name }}</span>
              <b>{{ book.records.filter(r => r.kind === entry.kind).length }}</b>
            </button>
          </div>
        </section>
      </div>
      <section class="activities" aria-labelledby="overview-activities">
        <div class="heading">
          <h2 id="overview-activities">
            作品活动 <small v-if="data">{{ data.activities.length + data.scripts.length }}</small>
          </h2>
          <button class="text-action" @click="emit('activity')">
            活动目录 <ArrowRight :size="15" aria-hidden="true" />
          </button>
        </div>
        <template v-if="data?.activities.length">
          <h3>低代码活动</h3>
          <button v-for="a in data.activities" :key="a.key" class="activity-row" @click="emit('activity', a.key)">
            <span class="activity-name"
              ><strong>{{ a.title }}</strong
              ><small>{{ a.key }}</small></span
            >
            <span class="choices">{{ a.count }} 个玩家选项</span><ChevronRight :size="16" aria-hidden="true" />
          </button>
        </template>
        <template v-if="data?.scripts.length">
          <h3>手写活动脚本</h3>
          <button v-for="id in data.scripts" :key="id" class="activity-row script" @click="emit('script', id)">
            <span class="script-id">{{ id }}</span
            ><ChevronRight :size="16" aria-hidden="true" />
          </button>
        </template>
        <p v-if="data && !data.activities.length && !data.scripts.length">
          包里还没有低代码或手写活动，可从活动目录创建。
        </p>
      </section>
    </div>
  </section>
</template>
<style scoped>
.overview {
  grid-column: 2 / -1;
  min-width: 0;
  background: #fff;
  color: var(--work-ink);
  padding: clamp(24px, 3.5vw, 54px);
}
.overview-body {
  max-width: 72rem;
  margin-inline: auto;
}
.work-identity,
.summary,
.heading,
.slot-row,
.activity-row,
.indexes {
  display: grid;
  align-items: center;
}
.work-identity {
  grid-template-columns: minmax(0, 1fr) clamp(128px, 16vw, 200px);
  gap: clamp(18px, 3vw, 54px);
  padding-bottom: 24px;
  border-bottom: 2px solid var(--work-ink);
}
.section-label,
.metadata,
.choices,
.activity-row small {
  font-size: 12px;
  color: var(--work-muted);
}
.section-label {
  font-weight: 650;
  margin: 0 0 8px;
}
h1,
h2,
h3,
p {
  margin: 0;
}
h1 {
  font-size: clamp(26px, 3vw, 44px);
  font-weight: 700;
  line-height: 1.24;
  letter-spacing: -0.035em;
  text-wrap: balance;
  word-break: keep-all;
  overflow-wrap: anywhere;
}
h2 {
  font-size: 19px;
  line-height: 1.35;
  font-weight: 700;
}
.metadata {
  display: flex;
  gap: 6px 12px;
  flex-wrap: wrap;
  margin-top: 12px;
  font-family: var(--work-mono);
  overflow-wrap: anywhere;
}
.metadata span + span {
  border-inline-start: 1px solid #ccc;
  padding-inline-start: 12px;
}
.cover {
  position: relative;
  cursor: pointer;
  display: grid;
  justify-items: end;
  gap: 3px;
  color: var(--work-muted);
}
.cover img {
  width: 100%;
  aspect-ratio: 16/9;
  object-fit: contain;
  background: #f5f5f5;
}
.cover span,
.text-action,
.slot-row span,
.indexes span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.cover span {
  font-size: 12px;
}
.cover.empty {
  min-height: 86px;
  justify-items: center;
  align-content: center;
  background: #f8f8f8;
  border: 1px dashed #bcbcbc;
  border-radius: 3px;
}
.cover.empty span {
  flex-direction: column;
  gap: 5px;
}
.cover input {
  opacity: 0;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
}
.cover:hover {
  color: var(--work-ink);
}
.cover:focus-within {
  outline: 2px solid var(--work-ink);
  outline-offset: 2px;
}
button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  border: 0;
  background: none;
}
button:focus-visible {
  outline: 2px solid var(--work-ink);
  outline-offset: 2px;
}
.summary {
  grid-template-columns: 1fr 1fr;
  align-items: start;
  padding: 22px 0;
  border-bottom: 1px solid var(--work-line);
}
.opening {
  padding-right: clamp(16px, 3vw, 44px);
}
.content-index {
  padding-left: clamp(16px, 3vw, 44px);
  border-left: 1px solid var(--work-line);
}
.slot-row {
  width: 100%;
  text-align: start;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;
  gap: 10px;
  padding: 8px 0;
  margin-top: 6px;
}
.slot-row strong {
  font-size: 16px;
  overflow-wrap: anywhere;
}
.slot-row span {
  font-size: 13px;
  color: var(--work-muted);
  overflow-wrap: anywhere;
}
.slot-row svg,
.activity-row svg {
  flex: none;
  color: var(--work-muted);
}
.text-action {
  font-size: 13px;
  font-weight: 600;
  min-height: 32px;
  padding: 2px 0;
}
.text-action:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.indexes {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 11px;
}
.indexes button {
  display: grid;
  align-content: start;
  justify-items: start;
  gap: 3px;
  text-align: left;
  padding: 3px 8px;
}
.indexes button:first-child {
  margin-left: -8px;
}
.indexes span {
  font-size: 12px;
  color: var(--work-muted);
}
.indexes b {
  font-size: 28px;
  font-weight: 650;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}
.activities {
  margin-top: 24px;
}
.heading {
  grid-template-columns: 1fr auto;
  gap: 10px;
  margin-bottom: 12px;
}
.heading small {
  font-size: 14px;
  font-weight: 500;
  color: var(--work-muted);
  margin-left: 4px;
}
.activities h3 {
  font-size: 12px;
  font-weight: 600;
  color: var(--work-muted);
  background: #f4f4f4;
  padding: 6px 12px;
}
.activity-row {
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 14px;
  width: 100%;
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--work-line);
}
.activity-row.script {
  grid-template-columns: minmax(0, 1fr) auto;
}
.activity-name,
.script-id {
  overflow-wrap: anywhere;
}
.activity-name small {
  display: block;
  font-family: var(--work-mono);
}
.script-id {
  font: 500 13px/1.5 var(--work-mono);
}
.slot-row:hover,
.activity-row:hover,
.indexes button:hover {
  background: #f5f5f5;
}
.overview [role='alert'] {
  color: #9b2020;
  margin-top: 10px;
}
@media (max-width: 860px) {
  .overview {
    grid-column: 1/-1;
  }
}
@media (max-width: 620px) {
  .overview {
    padding: 20px 16px 30px;
  }
  .work-identity {
    grid-template-columns: 1fr;
    gap: 12px;
    padding-bottom: 16px;
  }
  .cover {
    width: 140px;
    justify-items: start;
  }
  .cover.empty {
    width: fit-content;
    min-height: 32px;
    padding-inline: 10px;
  }
  .cover.empty span {
    flex-direction: row;
  }
  .summary {
    grid-template-columns: 1fr;
    gap: 16px;
    padding: 16px 0;
  }
  .opening {
    padding: 0;
  }
  .content-index {
    padding: 14px 0 0;
    border-left: 0;
    border-top: 1px solid var(--work-line);
  }
  .activities {
    margin-top: 18px;
  }
}
</style>
