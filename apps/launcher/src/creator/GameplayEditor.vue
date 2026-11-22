<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { editorRequest } from './editor-api.ts'
import type { rpgBook, RpgSource } from '../../../host/src/editor/rpg.ts'
import ModeConfigFields from './ModeConfigFields.vue'
import RpgCombatFields from './RpgCombatFields.vue'
import RpgMapItems from './RpgMapItems.vue'
import RpgJourneyFields from './RpgJourneyFields.vue'
import RpgCueEditor from './RpgCueEditor.vue'
import type { playRpgCue } from '../../../host/src/editor/rpg-cue-play.ts'
import type { playRpgJourney } from '../../../host/src/editor/rpg-journey-play.ts'
import type { playExit } from '../../../host/src/editor/rpg-exit-play.ts'
type Book = ReturnType<typeof rpgBook>
const props = defineProps<{ initial?: string | undefined; initialField?: string | undefined }>(),
  emit = defineEmits<{ page: [key: string]; item: [id: string] }>()
const tabs = ['遭遇地图', '技能', '敌人', '角色', '休息与返回', '队伍', '完整配置', '源配置'] as const
const tab = ref<(typeof tabs)[number]>('遭遇地图'),
  book = ref<Book>(),
  config = ref<RpgSource>(),
  entry = ref(''),
  index = ref(0),
  raw = ref('')
const scenes = ref<Record<string, string>>({}),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  conflict = ref(false)
const preview = ref<{ url: string; started: boolean }>()
const exitTrial = ref<Awaited<ReturnType<typeof playExit>>>()
const journeyTrial = ref<Awaited<ReturnType<typeof playRpgJourney>>>()
const mapFields = ref<InstanceType<typeof RpgMapItems>>()
const cueFields = ref<InstanceType<typeof RpgCueEditor>>(),
  cueTrial = ref<Awaited<ReturnType<typeof playRpgCue>>>()
const map = computed(() => config.value?.maps?.[index.value]),
  dirty = computed(
    () =>
      (book.value?.enabled && (tab.value === '源配置' ? raw.value !== pretty(config.value) : false)) ||
      JSON.stringify(config.value) !== JSON.stringify(book.value?.config ?? undefined),
  )
const unused = computed(
  () => book.value?.locations.filter(l => !config.value?.maps?.some(m => m.locationId === l.id)) ?? [],
)
function pretty(v: unknown) {
  return JSON.stringify(v, null, 2) ?? ''
}
function readBook(b: Book) {
  book.value = b
  config.value = b.config ? JSON.parse(JSON.stringify(b.config)) : undefined
  raw.value = pretty(config.value)
  conflict.value = false
}
async function selectTab(t: (typeof tabs)[number]) {
  if (t === tab.value) return
  if (tab.value === '源配置') await save()
  raw.value = pretty(config.value)
  tab.value = t
}
async function reload() {
  readBook(await editorRequest<Book>('gameplay'))
  index.value = Math.max(
    0,
    book.value!.activities.findIndex(a => a.location === props.initial),
  )
  entry.value = book.value?.locations[0]?.id ?? ''
}
async function run(work: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await work()
  } catch (e) {
    if ((e as { status?: number }).status === 409) conflict.value = true
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function save() {
  if (!dirty.value || !book.value?.enabled) return
  const next = tab.value === '源配置' ? JSON.parse(raw.value) : config.value
  try {
    readBook(await editorRequest<Book>('rpg-save', { file: book.value.file, base: book.value.config, config: next }))
    notice.value = '玩法配置已保存'
  } catch (e) {
    if ((e as { status?: number }).status === 409) conflict.value = true
    throw e
  }
}
async function flush() {
  if (busy.value) throw Error('玩法配置正在处理')
  await save()
}
defineExpose({ flush })
async function enable() {
  readBook(await editorRequest<Book>('rpg-enable', { location: entry.value }))
  notice.value = 'RPG 已启用'
}
function addMap() {
  const place = unused.value[0]
  if (!place || !config.value) return
  ;(config.value.maps ??= []).push({ locationId: place.id, narration: { first: '你来到了' + place.name + '。' } })
  index.value = config.value.maps.length - 1
}
async function openPage() {
  let key: string | undefined
  await run(async () => {
    await save()
    key = book.value?.activities.find(a => a.location === map.value?.locationId)?.key
  })
  if (key) emit('page', key)
}
async function play() {
  await save()
  preview.value = await editorRequest('rpg-preview', {
    location: map.value?.locationId,
    scenes: Object.fromEntries(Object.entries(scenes.value).filter(([, v]) => v)),
  })
}
async function playRoute(to: string) {
  exitTrial.value = undefined
  await save()
  exitTrial.value = await editorRequest('rpg-exit-play', {
    location: map.value?.locationId,
    to,
    scenes: Object.fromEntries(Object.entries(scenes.value).filter(([, v]) => v)),
  })
}
async function playJourney(body: Record<string, unknown>) {
  journeyTrial.value = undefined
  await save()
  journeyTrial.value = await editorRequest('rpg-journey-play', body)
}
async function playCue(index: number) {
  cueTrial.value = undefined
  const location = map.value?.locationId,
    expected = map.value?.scripted?.[index]
  if (!expected) return
  await save()
  cueTrial.value = await editorRequest('rpg-cue-play', { location, index, expected })
}
watch(
  [config, tab],
  () => {
    journeyTrial.value = undefined
  },
  { deep: true },
)
watch(
  [config, scenes, index],
  () => {
    preview.value = undefined
    exitTrial.value = undefined
    cueTrial.value = undefined
  },
  { deep: true },
)
onMounted(async () => {
  await run(reload)
  await nextTick()
  const field = props.initialField
  if (field?.startsWith('cue-')) await cueFields.value?.focus(Number(field.slice(4)))
  else if (field) mapFields.value?.focusField(field)
})
</script>
<template>
  <section class="gameplay">
    <header>
      <h2>玩法配置</h2>
      <span v-if="dirty">有未保存修改</span
      ><button v-if="book?.enabled" :disabled="busy || !dirty" @click="run(save)">保存玩法配置</button>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="conflict" @click="run(reload)">重新载入磁盘版本</button>
    <p v-if="busy || notice" role="status">{{ busy ? '正在处理…' : notice }}</p>
    <fieldset v-if="book" :disabled="busy" class="desk-body">
      <details>
        <summary>已启用玩法与插件（{{ book.plugins.length }}）</summary>
        <ul>
          <li v-for="p in book.plugins" :key="p.id">
            <b>{{ p.id }}</b> · {{ p.version ?? '包内版本' }} <code>{{ p.file }}</code>
            <details v-if="p.config && p.id !== 'official-rpg'">
              <summary>查看配置</summary>
              <pre>{{ pretty(p.config) }}</pre>
            </details>
          </li>
        </ul>
        <p v-if="book.gameplayScript">包内玩法脚本 · {{ book.gameplayScript.entry }}</p>
      </details>
      <template v-if="!book.enabled"
        ><h3>启用 RPG</h3>
        <p v-if="config">将接入已有的 {{ book.file }}。</p>
        <label v-else
          >首场遭遇地点 · 必填<select v-model="entry">
            <option v-for="l in book.locations" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select></label
        >
        <button :disabled="!config && !entry" @click="run(enable)">启用 RPG</button>
      </template>
      <template v-else-if="config"
        ><p>
          <b>官方 RPG</b> · <code>{{ book.file }}</code>
        </p>
        <nav aria-label="RPG 配置分类">
          <button v-for="t in tabs" :key="t" :aria-pressed="tab === t" @click="run(() => selectTab(t))">{{ t }}</button>
        </nav>
        <template v-if="tab === '遭遇地图'">
          <label
            >地图记录<select v-model.number="index">
              <option v-for="(m, i) in config.maps" :key="i" :value="i">
                {{ book.locations.find(l => l.id === m.locationId)?.name ?? m.locationId }}
              </option>
            </select></label
          >
          <button :disabled="!unused.length" @click="addMap">添加地图</button>
          <template v-if="map">
            <label
              >入口地点 · 必填<select v-model="map.locationId">
                <option
                  v-for="l in book.locations.filter(l => l.id === map?.locationId || unused.some(p => p.id === l.id))"
                  :key="l.id"
                  :value="l.id"
                >
                  {{ l.name }}
                </option>
              </select></label
            >
            <label>初到描述 · 必填<textarea v-model="map.narration.first" rows="2" required /></label>
            <label
              >再次到达描述 · 选填<textarea
                :value="map.narration.again ?? ''"
                rows="2"
                @input="
                  ($event.target as HTMLTextAreaElement).value
                    ? (map.narration.again = ($event.target as HTMLTextAreaElement).value)
                    : delete map.narration.again
                "
              />
            </label>
            <label
              >开战方式 · 选填<select
                :value="map.engage ?? 'on-enter'"
                @change="map.engage = ($event.target as HTMLSelectElement).value as 'on-enter' | 'optional'"
              >
                <option value="on-enter">进入即开战</option>
                <option value="optional">玩家选择开战</option>
              </select></label
            >
            <fieldset>
              <legend>遭遇敌人 · 选填</legend>
              <div v-for="(_, i) in map.enemies" :key="i" class="row">
                <label
                  >敌人 {{ i + 1
                  }}<select v-model="map.enemies![i]">
                    <option v-for="(e, id) in config.enemies" :key="id" :value="id">{{ e.name }}</option>
                  </select></label
                ><button @click="map.enemies!.splice(i, 1)">移除</button>
              </div>
              <button
                :disabled="!Object.keys(config.enemies ?? {}).length"
                @click="(map.enemies ??= []).push(Object.keys(config.enemies ?? {})[0]!)"
              >
                添加遭遇敌人
              </button>
            </fieldset>
            <RpgCueEditor
              ref="cueFields"
              v-model="config"
              :key="map.locationId"
              :book="book"
              :map-index="index"
              :result="cueTrial"
              @clear="cueTrial = undefined"
              @trial="i => run(() => playCue(i))"
              @characters="run(() => selectTab('角色'))"
            />
            <RpgMapItems
              ref="mapFields"
              :key="index"
              v-model="config"
              :index="index"
              :book="book"
              @item="id => emit('item', id)"
              @trial="to => run(() => playRoute(to))"
            />
            <div v-if="exitTrial" role="status">
              <b>{{ exitTrial.passed ? '通行试玩通过' : '通行试玩停在以下步骤' }}</b>
              <ol>
                <li v-for="c in exitTrial.checks" :key="c.step">
                  {{ c.passed ? '通过' : '失败' }} · {{ c.step }} · {{ c.message }}
                </li>
              </ol>
            </div>
            <details open>
              <summary>裁定来源 · {{ book.ruling.plugin }}</summary>
              <p>
                本次遭遇由
                <code>{{ book.file }}</code>
                中的地图、角色、敌人和技能共同决定。官方战斗规则负责行动顺序、扣费和伤害结算。
              </p>
              <small>引擎源码 · {{ book.ruling.combat }}</small>
            </details>
            <p>
              专属页面 · {{ book.activities.find(a => a.location === map?.locationId)?.page?.html ?? '使用默认舞台' }}
            </p>
            <button @click="openPage">编辑此活动的专属页面</button>
            <fieldset>
              <legend>试玩起点</legend>
              <label v-for="c in book.characters" :key="c.id"
                >{{ c.name
                }}<select v-model="scenes[c.id]">
                  <option :value="undefined">{{ c.id === book.player ? '从所选地图进入' : '沿用包内起点' }}</option>
                  <option v-for="s in book.scenes" :key="s.id" :value="s.id">{{ s.name }} · {{ s.id }}</option>
                </select></label
              >
              <button @click="run(play)">启动战斗试玩</button
              ><a v-if="preview" :href="preview.url" target="_blank" rel="noopener">打开玩家舞台</a>
              <p v-if="preview && !preview.started">当前起点未触发这张地图，请核对场景或在舞台内移动。</p>
            </fieldset>
          </template>
        </template>
        <ModeConfigFields
          v-else-if="tab === '完整配置'"
          mode="rpg"
          :schema="book.schema"
          :records="book"
          :config="config"
          @change="v => (config = v as unknown as RpgSource)"
        />
        <template v-else-if="tab === '源配置'"
          ><label>RPG 源配置<textarea v-model="raw" spellcheck="false" rows="20" /></label>
          <details>
            <summary>查看字段与必填声明</summary>
            <pre>{{ pretty(book.schema) }}</pre>
          </details></template
        >
        <RpgJourneyFields
          v-else-if="tab === '休息与返回' || tab === '队伍'"
          :key="tab"
          v-model="config"
          :kind="tab"
          :book="book"
          :result="journeyTrial"
          @trial="body => run(() => playJourney(body))"
          @clear="journeyTrial = undefined"
          @characters="run(() => selectTab('角色'))"
        />
        <RpgCombatFields
          v-else
          v-model="config"
          :kind="tab"
          :characters="book.characters"
          :slots="book.slots"
          :book="book"
        />
      </template>
    </fieldset>
  </section>
</template>
<style scoped>
.gameplay {
  max-width: 58rem;
  margin: 0 auto;
  padding: 1rem 1.5rem;
}
.gameplay header,
.gameplay nav,
.row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.gameplay header {
  border-bottom: 1px solid #b8c9c3;
}
.gameplay header h2 {
  margin-right: auto;
}
.desk-body {
  display: grid;
  gap: 0.85rem;
  min-width: 0;
  border: 0;
  padding: 1rem 0;
}
.desk-body > button,
.desk-body > label {
  justify-self: start;
}
.gameplay label {
  display: grid;
  gap: 0.3rem;
}
.gameplay fieldset fieldset {
  min-width: 0;
  display: grid;
  gap: 0.6rem;
  border: 1px solid #b8c9c3;
}
.gameplay :deep(input:not([type='checkbox'])),
.gameplay :deep(select),
.gameplay :deep(textarea) {
  font: inherit;
  padding: 0.4rem;
  max-width: 100%;
  box-sizing: border-box;
}
.gameplay :deep(button),
.gameplay a {
  width: fit-content;
}
.gameplay button[aria-pressed='true'] {
  font-weight: bold;
  text-decoration: underline;
  text-underline-offset: 0.3rem;
}
.gameplay pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.gameplay textarea {
  min-width: min(32rem, 100%);
}
.gameplay p {
  margin: 0.3rem 0;
}
</style>
