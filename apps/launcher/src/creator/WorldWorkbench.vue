<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watchEffect } from 'vue'
import {
  BookOpen,
  MapPin,
  Users,
  Workflow,
  SlidersHorizontal,
  ChevronDown,
  Menu,
  Play,
  FileBox,
  Search,
  Plus,
} from '@lucide/vue'
import { editorRequest, selectEditorWorkspace } from './editor-api.ts'
import InteractionScript from './InteractionScript.vue'
import RulingScripts from './RulingScripts.vue'
import StageEditor from './StageEditor.vue'
import WorldSetupEditor from './WorldSetupEditor.vue'
import PluginConfigEditor from './PluginConfigEditor.vue'
import GameplayEditor from './GameplayEditor.vue'
import ItemUses from './ItemUses.vue'
import RpgRecordFields from './RpgRecordFields.vue'
import type { ItemUse } from '../../../host/src/editor/item-uses.ts'
import ActivityPageEditor from './ActivityPageEditor.vue'
import PresetEditor from './PresetEditor.vue'
import KnowledgeEditor from './KnowledgeEditor.vue'
import RuleEditor from './RuleEditor.vue'
import OpeningLocationIssues from './OpeningLocationIssues.vue'
import LocationOpening from './LocationOpening.vue'
import LocationItems from './LocationItems.vue'
import WorkOverview from './WorkOverview.vue'
import type { ActivityReference } from '../../../host/src/editor/activity-references.ts'
import ActivityEditor from './ActivityEditor.vue'
import {
  sections,
  fields,
  kinds,
  choiceNames,
  initialValues,
  openingLocationIssues,
  sceneBindingIssues,
  referenceCandidates,
  referencesTo,
  type RecordKind,
  type Values,
  type WorldRecord,
  type WorldField,
} from '@perspectra/world-pack/editor-fields'
import type { saveRecord, worldRecords } from '../../../host/src/editor/world-records.ts'
import type { previewOpening } from '../../../host/src/editor/workspace.ts'

type Book = ReturnType<typeof worldRecords>
type Receipt = ReturnType<typeof saveRecord>
const book = ref<Book>(),
  home = ref(false),
  picker = ref(false),
  busy = ref(false),
  error = ref(''),
  notice = ref('')
type WorkSection =
  | RecordKind
  | 'overview'
  | 'activity'
  | 'rules'
  | 'knowledge'
  | 'presets'
  | 'pages'
  | 'interactions'
  | 'scripts'
  | 'gameplay'
  | 'trpg'
  | 'communication'
  | 'autonomy'
  | 'stage'
  | 'setup'
const sectionLabels: Record<WorkSection, string> = {
  ...sections,
  overview: '作品总览',
  setup: '世界与角色开局',
  communication: '角色通讯录',
  autonomy: '角色自主机会',
  activity: '活动流程图',
  rules: '变量与世界事件',
  interactions: '日常交互',
  scripts: '规则脚本',
  knowledge: '知识库',
  presets: '文风与模型预设',
  gameplay: '玩法配置',
  trpg: '跑团玩法',
  stage: '舞台与美术',
  pages: '活动专属页面',
}
const categories = [
  { title: '作品总览', main: 'overview', icon: BookOpen, entries: ['slot', 'setup'] },
  { title: '地点与舞台', main: 'location', icon: MapPin, entries: ['scene', 'item', 'stage'] },
  { title: '角色', main: 'character', icon: Users, entries: ['knowledge'] },
  { title: '活动与规则', main: 'activity', icon: Workflow, entries: ['rules', 'interactions', 'scripts', 'pages'] },
  {
    title: '玩法与设置',
    main: 'gameplay',
    icon: SlidersHorizontal,
    entries: ['trpg', 'communication', 'autonomy', 'presets'],
  },
] satisfies { title: string; main: WorkSection; icon: typeof BookOpen; entries: WorkSection[] }[]
const expandedGroup = ref<WorkSection | null>('overview'),
  mobileDirectory = ref(false)
const facetNames = {
  basic: '基本资料',
  setup: '设定与认知',
  portrait: '立绘',
  contacts: '通讯录',
  rpg: 'RPG 属性',
  items: '此地物品',
  background: '地点背景',
}
type Facet = keyof typeof facetNames
const facet = ref<Facet>('basic')
const facetEditor = ref<{ flush: () => Promise<void> }>()
const facets = computed<Facet[]>(() => {
  if (record.value?.kind === 'location') return ['basic', 'items', 'background']
  if (record.value?.kind !== 'character') return []
  const enabled = book.value?.enabledPlugins
  const result: Facet[] = ['basic', 'setup', 'portrait']
  if (!enabled || enabled.includes('official-communication')) result.push('contacts')
  if (!enabled || enabled.includes('official-rpg')) result.push('rpg')
  return result
})
async function changeFacet(next: Facet) {
  if (next === facet.value) return
  await run(async () => {
    await save()
    await refresh()
    const current = book.value?.records.find(r => r.kind === section.value && r.id === record.value?.id)
    pick(current)
    facet.value = facets.value.includes(next) ? next : 'basic'
  })
}
const returnRef = ref<ActivityReference>()
const recordCounts = computed(
  () => new Map(kinds.map(k => [k as WorkSection, book.value?.records.filter(r => r.kind === k).length ?? 0])),
)
watchEffect(() => {
  document.title = [book.value?.title, '包编辑', 'Perspectra'].filter(Boolean).join(' · ')
})
const section = ref<WorkSection>('overview'),
  record = ref<WorldRecord>(),
  form = ref<Values>({}),
  draftNew = ref(false),
  search = ref(''),
  refSearch = ref<Record<string, string>>({})
const overview = ref<InstanceType<typeof WorkOverview>>()
const locationOpening = ref<InstanceType<typeof LocationOpening>>()
const activity = ref<InstanceType<typeof ActivityEditor>>()
const stageEditor = ref<InstanceType<typeof StageEditor>>()
const setupEditor = ref<InstanceType<typeof WorldSetupEditor>>(),
  setupCharacter = ref<string>()
const pluginEditor = ref<InstanceType<typeof PluginConfigEditor>>(),
  contactCharacter = ref<string>()
const gameplayEditor = ref<InstanceType<typeof GameplayEditor>>()
const rpgRecord = ref<InstanceType<typeof RpgRecordFields>>(),
  itemUseVersion = ref(0)
const workspaceVersion = ref(0)
const gameplayLocation = ref<string>()
const initialField = ref<string>(),
  initialEvent = ref<string>()
const pageKey = ref<string>()
const interactionsEditor = ref<InstanceType<typeof InteractionScript>>()
const scriptsEditor = ref<InstanceType<typeof RulingScripts>>()
const scriptKey = ref<string>()
const pageEditor = ref<InstanceType<typeof ActivityPageEditor>>()
const presetEditor = ref<InstanceType<typeof PresetEditor>>()
const presetKey = ref<string>()
const knowledgeEditor = ref<InstanceType<typeof KnowledgeEditor>>()
const knowledgeId = ref<string>()
type AuthorReference = { section: 'knowledge' | 'presets' | 'pages' | 'rules'; id: string; label: string }
const actorUses = ref<ActivityReference[]>([])
const readerRefs = ref<AuthorReference[]>([])
async function loadReaderRefs(e: Event) {
  const id = record.value?.id
  const kind = record.value?.kind
  if (!(e.target as HTMLDetailsElement).open || (kind !== 'character' && kind !== 'location')) return
  try {
    const results = await Promise.all(
      (kind === 'character'
        ? ['knowledge-references', 'preset-references', 'event-references']
        : ['event-references', 'knowledge-references']
      ).map(operation => editorRequest<AuthorReference[]>(operation, { kind, id })),
    )
    const uses =
      kind === 'character'
        ? await editorRequest<ActivityReference[]>('activity-references', { kind: 'present', id })
        : []
    if (record.value?.id === id) {
      readerRefs.value = results.flat()
      actorUses.value = uses
    }
  } catch (e) {
    error.value = (e as Error).message
  }
}
const ruleEditor = ref<InstanceType<typeof RuleEditor>>()
const activityOpened = ref(false)
const origin = ref<{ kind: RecordKind; id: string; search: string; facet: Facet }>()
const quick = ref(''),
  quickName = ref(''),
  modal = ref<'' | 'open' | 'new' | 'play'>(''),
  folder = ref('')
const opening = ref({ title: '', player: '玩家', companion: '', location: '' }),
  line = ref(''),
  trial = ref<Awaited<ReturnType<typeof previewOpening>>>()
const conflict = ref<{ key: string; current: string | string[]; proposed: string | string[] }>()
const lastSave = ref<Receipt>()
const rows = computed(
  () =>
    book.value?.records.filter(
      r => r.kind === section.value && (r.name + ' ' + r.id).toLowerCase().includes(search.value.toLowerCase()),
    ) ?? [],
)
const currentFields = computed(() =>
  section.value === 'overview' ||
  section.value === 'activity' ||
  section.value === 'rules' ||
  section.value === 'knowledge' ||
  section.value === 'presets' ||
  section.value === 'pages' ||
  section.value === 'gameplay' ||
  section.value === 'stage' ||
  section.value === 'setup' ||
  section.value === 'autonomy' ||
  section.value === 'communication' ||
  section.value === 'trpg' ||
  section.value === 'interactions' ||
  section.value === 'scripts'
    ? []
    : fields[section.value],
)
const dirty = computed(
  () => draftNew.value || (!!record.value && JSON.stringify(form.value) !== JSON.stringify(record.value.values)),
)
const playerId = computed(() => book.value?.records.find(r => r.kind === 'slot')?.values.characterId)
const previewRecords = computed(() => {
  const records = book.value?.records ?? []
  if (!dirty.value || (section.value !== 'character' && section.value !== 'scene')) return records
  const edited: WorldRecord = {
    kind: section.value,
    id: record.value?.id ?? '',
    name: String(form.value.displayName ?? record.value?.name ?? ''),
    file: record.value?.file ?? '',
    values: form.value,
  }
  return [...records.filter(r => r.kind !== edited.kind || r.id !== edited.id), edited]
})
const locationIssues = computed(() => openingLocationIssues(previewRecords.value))
const bindingIssues = computed(() => sceneBindingIssues(previewRecords.value))
function bindingsFor(kind: WorkSection, id: string) {
  return bindingIssues.value.filter(i =>
    kind === 'location' ? i.locationId === id : kind === 'scene' && i.scenes.some(s => s.id === id),
  )
}
const recordBindings = computed(() => bindingsFor(section.value, record.value?.id ?? ''))
function issuesFor(kind: WorkSection, id: string) {
  return locationIssues.value.filter(issue =>
    kind === 'character' ? issue.characterId === id : kind === 'scene' && issue.sceneId === id,
  )
}
const recordIssues = computed(() => issuesFor(section.value, record.value?.id ?? ''))
function invalidLocationField(field: string) {
  if (section.value === 'scene' && recordBindings.value.length && (field === 'locationId' || field === 'lifecycle'))
    return true
  return (
    !!recordIssues.value.length &&
    (section.value === 'character'
      ? field === 'initialLocationId'
      : field === 'locationId' || field === 'participantIds')
  )
}
async function locateOpeningField(kind: 'character' | 'scene', id: string, field: string) {
  if (section.value === kind && (record.value?.id ?? '') === id) {
    if (facet.value !== 'basic') {
      await changeFacet('basic')
      await nextTick()
    }
    document.getElementById('field-' + field)?.focus()
    return
  }
  await follow(kind, id, field)
}
const inbound = computed(() =>
  record.value && book.value ? referencesTo(book.value.records, record.value.kind, record.value.id) : [],
)
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
function pick(r?: WorldRecord) {
  if (r?.id !== record.value?.id || r?.kind !== record.value?.kind) facet.value = 'basic'
  readerRefs.value = []
  actorUses.value = []
  record.value = r
  form.value = r ? copy(r.values) : {}
  draftNew.value = false
  refSearch.value = {}
  quick.value = ''
  conflict.value = undefined
}
async function run(fn: () => Promise<void>) {
  if (busy.value) return
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    await fn()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function refresh() {
  book.value = await editorRequest<Book>('records')
}
function view(kind: WorkSection, id?: string, field?: string) {
  facet.value = 'basic'
  expandedGroup.value =
    categories.find(g => g.main === kind || (g.entries as WorkSection[]).includes(kind))?.main ?? null
  mobileDirectory.value = false
  initialField.value = field
  if (kind === 'rules') initialEvent.value = id
  if (kind === 'setup') setupCharacter.value = id
  if (kind === 'communication') contactCharacter.value = id
  if (kind === 'gameplay') gameplayLocation.value = id
  if (kind === 'pages') pageKey.value = id
  if (kind === 'scripts') scriptKey.value = id
  if (kind === 'activity') activityOpened.value = true
  if (kind === 'knowledge') knowledgeId.value = id
  if (kind === 'presets') presetKey.value = id
  section.value = kind
  search.value = ''
  pick(kind === 'activity' ? undefined : book.value?.records.find(r => r.kind === kind && (!id || r.id === id)))
}
async function save() {
  if (section.value === 'overview') return overview.value?.flush()
  if (section.value === 'stage') {
    await stageEditor.value?.flush()
    return
  }
  if (section.value === 'setup') {
    await setupEditor.value?.flush()
    return
  }
  if (section.value === 'trpg' || section.value === 'communication' || section.value === 'autonomy') {
    await pluginEditor.value?.flush()
    return
  }
  if (section.value === 'gameplay') {
    await gameplayEditor.value?.flush()
    return
  }
  if (section.value === 'interactions') {
    await interactionsEditor.value?.flush()
    return
  }
  if (section.value === 'scripts') {
    await scriptsEditor.value?.flush()
    return
  }
  if (section.value === 'pages') {
    await pageEditor.value?.flush()
    return
  }
  if (section.value === 'presets') {
    await presetEditor.value?.flush()
    return
  }
  if (section.value === 'knowledge') {
    await knowledgeEditor.value?.flush()
    return
  }
  if (section.value === 'rules') {
    await ruleEditor.value?.flush()
    return
  }
  if (section.value === 'activity') {
    await activity.value?.flush()
    return
  }
  await facetEditor.value?.flush()
  await rpgRecord.value?.flush()
  await locationOpening.value?.flush()
  await saveWorldRecord()
}
async function saveWorldRecord() {
  if (!dirty.value) return
  const values = form.value
  try {
    const out = await editorRequest<Receipt>('record-save', {
      kind: section.value,
      id: record.value?.id,
      base: record.value?.values ?? null,
      values,
    })
    lastSave.value = out
    await refresh()
    pick(book.value?.records.find(r => r.kind === section.value && r.id === out.saved.id))
    notice.value = '已保存'
  } catch (e) {
    const d = (e as { details?: { field: string; current: string | string[]; proposed: string | string[] } }).details
    if (record.value && d?.field?.startsWith(record.value.id + '/'))
      conflict.value = { key: d.field.slice(record.value.id.length + 1), current: d.current, proposed: d.proposed }
    throw e
  }
}
async function saveRecordForTrial() {
  if (busy.value) throw new Error('请等当前记录操作完成')
  busy.value = true
  try {
    await saveWorldRecord()
  } finally {
    busy.value = false
  }
}
async function choose(kind: WorkSection, id?: string, field?: string, targetFacet?: Facet) {
  await run(async () => {
    await save()
    await refresh()
    if (kind === 'presets' && section.value === 'presets') await presetEditor.value?.reload()
    if (kind === 'knowledge' && section.value === 'knowledge') await knowledgeEditor.value?.reload()
    view(kind, id, field)
    if (targetFacet && facets.value.includes(targetFacet)) facet.value = targetFacet
    if (kind === 'activity') {
      await nextTick()
      await activity.value?.openActivity(id)
    }
    returnRef.value = undefined
    origin.value = undefined
  })
}
async function openDefinition(r: ActivityReference) {
  const section =
    r.kind === 'present' ? 'character' : r.kind === 'held' ? 'item' : r.kind === 'world' ? 'rules' : 'scripts'
  await choose(section, r.kind === 'script' ? 'ruling/' + r.id : r.id, r.kind === 'world' ? 'variable' : undefined)
  if (!error.value) returnRef.value = r
}
async function showOpeningIssues() {
  await choose('overview')
  await nextTick()
  document.getElementById('opening-diagnostics')?.focus()
}
async function focusActivity(key: string, id: string, field: string, reference?: string) {
  let opened = false
  await run(async () => {
    await save()
    view('activity')
    await nextTick()
    await activity.value?.openChoice(key, id)
    opened = true
  })
  if (opened) {
    await nextTick()
    activity.value?.focusField(field, reference)
  }
}
function openItemUse(use: ItemUse) {
  if (use.section === 'item' && record.value?.id === use.id) return rpgRecord.value?.focusField(use.field)
  if (use.section === 'activity' && use.choice)
    return focusActivity(use.id, use.choice, use.field, 'held/' + record.value?.id)
  return choose(use.section, use.id, use.field)
}
function begin() {
  if (
    section.value === 'overview' ||
    section.value === 'activity' ||
    section.value === 'rules' ||
    section.value === 'knowledge' ||
    section.value === 'presets' ||
    section.value === 'pages' ||
    section.value === 'gameplay' ||
    section.value === 'stage' ||
    section.value === 'setup' ||
    section.value === 'autonomy' ||
    section.value === 'communication' ||
    section.value === 'trpg' ||
    section.value === 'interactions' ||
    section.value === 'scripts'
  )
    return
  pick()
  draftNew.value = true
  form.value = initialValues(section.value)
}
function options(f: WorldField) {
  if (
    !book.value ||
    section.value === 'overview' ||
    section.value === 'activity' ||
    section.value === 'rules' ||
    section.value === 'knowledge' ||
    section.value === 'presets' ||
    section.value === 'pages' ||
    section.value === 'gameplay' ||
    section.value === 'stage' ||
    section.value === 'setup' ||
    section.value === 'autonomy' ||
    section.value === 'communication' ||
    section.value === 'trpg' ||
    section.value === 'interactions' ||
    section.value === 'scripts'
  )
    return []
  const q = (refSearch.value[f.key] ?? '').toLowerCase(),
    v = form.value[f.key]
  return referenceCandidates(book.value.records, section.value, f.key).filter(
    r => r.id === v || (Array.isArray(v) && v.includes(r.id)) || (r.name + ' ' + r.id).toLowerCase().includes(q),
  )
}
function beginPlace(f: WorldField) {
  quick.value = f.key
  quickName.value = refSearch.value[f.key] ?? ''
}
async function addPlace(f: WorldField) {
  await run(async () => {
    const out = await editorRequest<Receipt>('record-save', {
      kind: 'location',
      base: null,
      values: { name: quickName.value },
    })
    await refresh()
    form.value[f.key] = out.saved.id
    refSearch.value[f.key] = ''
    quick.value = ''
    quickName.value = ''
  })
}
async function enter() {
  await run(async () => {
    const res = await editorRequest<{ workspace: string }>('workspace-select', {
      directory: folder.value,
      create: modal.value === 'new',
      ...opening.value,
    })
    const nextBook = await editorRequest<Book>('records', {}, res.workspace)
    const url = new URL(location.href)
    url.searchParams.set('workspace', res.workspace)
    history.replaceState(null, '', url)
    selectEditorWorkspace(res.workspace)
    workspaceVersion.value++
    book.value = nextBook
    returnRef.value = undefined
    activityOpened.value = false
    home.value = false
    view('overview')
    modal.value = ''
    origin.value = undefined
    lastSave.value = undefined
    trial.value = undefined
    line.value = ''
    folder.value = ''
    opening.value = { title: '', player: '玩家', companion: '', location: '' }
  })
}
async function initialize() {
  const s = await editorRequest<{ opened: boolean; picker: boolean }>('workspace-status')
  picker.value = s.picker
  home.value = !s.opened
  if (s.opened) {
    await refresh()
    view('overview')
  } else {
    book.value = undefined
    pick()
  }
}
async function openModal(m: 'open' | 'new' | 'play') {
  await run(async () => {
    await save()
    modal.value = m
    trial.value = undefined
  })
}
async function follow(kind: RecordKind, id: string, key?: string) {
  await run(async () => {
    await save()
    const r = record.value
    if (r) origin.value = { kind: r.kind, id: r.id, search: search.value, facet: facet.value }
    view(kind, id)
    if (key) requestAnimationFrame(() => document.getElementById('field-' + key)?.focus())
  })
}
async function selectRecord(r: WorldRecord) {
  await run(async () => {
    await save()
    await refresh()
    facet.value = 'basic'
    pick(book.value?.records.find(x => x.kind === r.kind && x.id === r.id))
    if (recordBindings.value.length) {
      requestAnimationFrame(() =>
        document.getElementById(r.kind === 'scene' ? 'field-locationId' : 'scene-binding-problems')?.focus(),
      )
    } else if (recordIssues.value.length) {
      const field = r.kind === 'character' ? 'initialLocationId' : 'participantIds'
      requestAnimationFrame(() => document.getElementById('field-' + field)?.focus())
    }
  })
}
async function back() {
  const last = origin.value
  if (!last) return
  await run(async () => {
    await save()
    view(last.kind, last.id)
    if (facets.value.includes(last.facet)) facet.value = last.facet
    search.value = last.search
    origin.value = undefined
  })
}
function resolveConflict(keep: boolean) {
  const c = conflict.value
  if (!record.value || !c) return
  record.value = { ...record.value, values: { ...record.value.values, [c.key]: c.current } }
  if (!keep) form.value[c.key] = c.current
  conflict.value = undefined
  void run(save)
}
async function discardInput() {
  await run(async () => {
    const id = record.value?.id
    await refresh()
    pick(book.value?.records.find(r => r.kind === section.value && r.id === id) ?? rows.value[0])
  })
}
onMounted(() => {
  void run(initialize)
})
</script>
<template>
  <main class="workbook">
    <header v-if="section !== 'activity' || modal" class="mast">
      <div class="brand"><b>Perspectra</b><span>创作工作台</span></div>
      <button v-if="book && !modal" class="project-name" :title="book.title" @click="choose('overview')">
        {{ book.title }}
      </button>
      <div v-if="book" class="tools">
        <button
          v-if="returnRef"
          @click="
            focusActivity(returnRef.activity, returnRef.choice, returnRef.field, returnRef.kind + '/' + returnRef.id)
          "
        >
          ← 返回引用字段
        </button>
        <button v-if="picker" :disabled="busy" @click="openModal('open')">打开作品</button
        ><button v-if="picker" :disabled="busy" @click="openModal('new')">新建作品</button
        ><button
          :disabled="busy"
          @click="
            run(async () => {
              await save()
              const out = await editorRequest<{ directory: string }>('export')
              notice = '已导出到 ' + out.directory
            })
          "
        >
          <FileBox :size="15" aria-hidden="true" />导出源包</button
        ><button class="primary" :disabled="busy" @click="openModal('play')">
          <Play :size="14" aria-hidden="true" />试玩开局
        </button>
      </div>
    </header>
    <p v-if="error" role="alert" class="alert">{{ error }}</p>
    <p v-if="notice || busy" role="status" class="save-status">{{ busy ? '正在处理…' : notice }}</p>
    <section v-if="home && !modal" class="home">
      <h1>我的作品</h1>
      <div class="entry">
        <button :disabled="busy" @click="openModal('open')">
          <b>打开已有包</b><span>继续编辑本机的世界源包 →</span></button
        ><button :disabled="busy" @click="openModal('new')"><b>新建作品</b><span>从角色和开局地点开始 →</span></button>
      </div>
    </section>
    <section
      v-if="modal"
      class="dialog"
      role="dialog"
      :aria-label="modal === 'play' ? '试玩开局' : modal === 'new' ? '新建作品' : '打开已有包'"
    >
      <button class="close" :disabled="busy" @click="modal = ''">返回</button>
      <h1>{{ modal === 'play' ? '试玩开局' : modal === 'new' ? '新建作品' : '打开已有包' }}</h1>
      <form v-if="modal !== 'play'" @submit.prevent="enter">
        <label
          >{{ modal === 'new' ? '新作品目录' : '已有源包目录' }} <em>必填</em
          ><input v-model="folder" required placeholder="输入本机目录路径"
        /></label>
        <template v-if="modal === 'new'"
          ><label
            v-for="(label, key) in {
              title: '作品名称',
              player: '玩家名',
              companion: '同行角色名',
              location: '开局地点',
            }"
            :key="key"
            >{{ label }} <em>必填</em><input required v-model="opening[key]" /></label
        ></template>
        <button class="primary" :disabled="busy">{{ modal === 'new' ? '创建并打开' : '打开世界包' }}</button>
      </form>
      <form
        v-else
        @submit.prevent="
          run(async () => {
            trial = await editorRequest('opening', { text: line })
          })
        "
      >
        <label
          >玩家的第一句话<input
            required
            maxlength="2000"
            v-model="line"
            placeholder="阿林，今天怎么这么安静？" /></label
        ><button class="primary" :disabled="busy">开新档并发言</button>
        <p>每次使用独立新档和宿主配置的游戏模型。</p>
        <div v-if="trial" class="transcript">
          <p v-for="(r, i) in trial.transcript" :key="i">
            <b>{{ r.speaker }}</b> {{ r.text }}
          </p>
          <p v-if="trial.notice">{{ trial.notice }}</p>
        </div>
      </form>
    </section>
    <div
      v-if="book"
      :key="workspaceVersion"
      v-show="!modal"
      :inert="busy"
      class="desk"
      :class="{ flow: section === 'activity' }"
    >
      <nav v-if="section !== 'activity'" class="directory" aria-label="作品目录" :class="{ expanded: mobileDirectory }">
        <div class="directory-head">
          <span>作品目录</span
          ><button
            type="button"
            class="mobile-toggle"
            :aria-label="mobileDirectory ? '收起作品目录' : '展开作品目录'"
            :aria-expanded="mobileDirectory"
            aria-controls="work-groups"
            @click="mobileDirectory = !mobileDirectory"
          >
            <Menu :size="15" /> {{ sectionLabels[section] }}
          </button>
        </div>
        <div id="work-groups" class="work-groups">
          <div v-for="category in categories" :key="category.main" class="nav-group">
            <div class="group-heading">
              <button
                :aria-current="section === category.main ? 'page' : undefined"
                :disabled="busy"
                @click="choose(category.main)"
              >
                <component :is="category.icon" :size="17" aria-hidden="true" />{{ category.title }}
              </button>
              <button
                class="disclosure"
                :aria-label="category.title + '子目录'"
                :aria-controls="'children-' + category.main"
                :aria-expanded="expandedGroup === category.main"
                @click="expandedGroup = expandedGroup === category.main ? null : category.main"
              >
                <ChevronDown :size="14" aria-hidden="true" />
              </button>
            </div>
            <div v-show="expandedGroup === category.main" class="child-links" :id="'children-' + category.main">
              <button
                v-for="entry in category.entries"
                :key="entry"
                :aria-current="section === entry ? 'page' : undefined"
                :disabled="busy"
                @click="choose(entry)"
              >
                {{ sectionLabels[entry] }}<span v-if="recordCounts.has(entry)">{{ recordCounts.get(entry) }}</span>
              </button>
            </div>
          </div>
          <button
            v-if="locationIssues.length + bindingIssues.length"
            class="directory-problems"
            @click="showOpeningIssues"
          >
            开局问题 <b>{{ locationIssues.length + bindingIssues.length }}</b>
          </button>
        </div>
      </nav>
      <WorkOverview
        ref="overview"
        v-if="section === 'overview'"
        :book="book"
        @activity="id => choose('activity', id)"
        @opening="openModal('play')"
        @slot="id => choose('slot', id)"
        @records="kind => choose(kind)"
        @script="id => choose('scripts', 'activity/' + id)"
        ><div v-if="locationIssues.length + bindingIssues.length" id="opening-diagnostics" tabindex="-1">
          <OpeningLocationIssues :issues="locationIssues" :bindings="bindingIssues" @locate="locateOpeningField" /></div
      ></WorkOverview>
      <div v-if="section === 'stage'" class="activities"><StageEditor ref="stageEditor" /></div>
      <div v-if="section === 'setup'" class="activities">
        <WorldSetupEditor
          :key="(setupCharacter ?? '') + '/' + (initialField ?? '')"
          ref="setupEditor"
          :initial-kind="initialField"
          :initial-character="setupCharacter"
        />
      </div>
      <div v-if="section === 'trpg' || section === 'communication' || section === 'autonomy'" class="activities">
        <PluginConfigEditor ref="pluginEditor" :key="section" :mode="section" :initial-character="contactCharacter" />
      </div>
      <div v-else-if="section === 'gameplay'" class="activities">
        <GameplayEditor
          :key="gameplayLocation ?? ''"
          ref="gameplayEditor"
          :initial="gameplayLocation"
          :initial-field="initialField"
          @page="id => choose('pages', id)"
          @item="id => choose('item', id)"
        />
      </div>
      <div v-if="section === 'interactions'" class="activities"><InteractionScript ref="interactionsEditor" /></div>
      <div v-if="section === 'scripts'" class="activities">
        <RulingScripts :key="scriptKey ?? ''" ref="scriptsEditor" :initial="scriptKey" @activity="focusActivity" />
      </div>
      <div v-if="section === 'pages'" class="activities">
        <ActivityPageEditor ref="pageEditor" :initial="pageKey" :initial-element="initialField" />
      </div>
      <div v-if="section === 'presets'" class="activities">
        <PresetEditor :key="presetKey ?? ''" ref="presetEditor" :initial-key="presetKey" />
      </div>
      <div v-if="section === 'knowledge'" class="activities">
        <KnowledgeEditor ref="knowledgeEditor" :initial-id="knowledgeId" />
      </div>
      <div v-if="section === 'rules'" class="activities">
        <RuleEditor
          ref="ruleEditor"
          :initial-event="initialField === 'variable' ? undefined : initialEvent"
          :initial-variable="initialField === 'variable' ? initialEvent : undefined"
          :records="book.records"
          @activity="focusActivity"
          @knowledge="id => choose('knowledge', id)"
        />
      </div>
      <div v-show="section === 'activity'" class="activities">
        <ActivityEditor
          v-if="activityOpened"
          ref="activity"
          :active="section === 'activity' && !modal"
          @overview="choose('overview')"
          @definition="openDefinition"
          @gameplay="(id, field) => choose('gameplay', id, field)"
          @page="id => choose('pages', id)"
          @script="id => choose('scripts', id)"
          @knowledge="id => choose('knowledge', id)"
        />
      </div>
      <template
        v-if="
          section !== 'overview' &&
          section !== 'activity' &&
          section !== 'rules' &&
          section !== 'knowledge' &&
          section !== 'presets' &&
          section !== 'pages' &&
          section !== 'gameplay' &&
          section !== 'stage' &&
          section !== 'setup' &&
          section !== 'trpg' &&
          section !== 'autonomy' &&
          section !== 'communication' &&
          section !== 'interactions' &&
          section !== 'scripts'
        "
        ><section class="register">
          <div class="register-heading">
            <h2>
              {{ sections[section] }} <small>{{ recordCounts.get(section) }}</small>
            </h2>
            <button
              v-if="section !== 'slot'"
              :disabled="busy"
              @click="
                run(async () => {
                  await save()
                  begin()
                })
              "
            >
              <Plus :size="14" aria-hidden="true" />新建{{ sections[section] }}
            </button>
          </div>
          <label class="record-search"
            ><Search :size="15" aria-hidden="true" /><input
              aria-label="查找记录"
              v-model="search"
              type="search"
              placeholder="按名称或 ID 查找"
          /></label>
          <div class="rows">
            <button
              v-for="r in rows"
              :key="r.id"
              :disabled="busy"
              :aria-pressed="record?.id === r.id"
              @click="selectRecord(r)"
            >
              <b
                >{{ r.name }}
                <span v-if="r.kind === 'character' && r.id === playerId" class="player-role">玩家角色</span></b
              >
              <small>{{ r.id }}</small>
              <span v-if="issuesFor(r.kind, r.id).length" class="location-warning">开局地点冲突</span>
              <span v-if="bindingsFor(r.kind, r.id).length" class="location-warning">场景绑定冲突</span>
            </button>
            <p v-if="!rows.length">没有匹配的{{ sections[section] }}。</p>
          </div>
        </section>
        <section class="inspector" v-if="record || draftNew">
          <div class="title">
            <div>
              <h1>{{ draftNew ? '新建' + sections[section] : record?.name }}</h1>
              <small v-if="record">{{ record.id }}</small>
            </div>
            <button v-if="origin" @click="back">返回原记录</button>
          </div>
          <div v-if="facets.length" class="facet-nav" role="group" aria-label="详情分区">
            <button v-for="f in facets" :key="f" :aria-pressed="facet === f" @click="changeFacet(f)">
              {{ f === 'basic' && section === 'location' ? '地点与开局' : facetNames[f] }}
            </button>
          </div>
          <OpeningLocationIssues :issues="recordIssues" :bindings="recordBindings" @locate="locateOpeningField" />
          <form v-if="facet === 'basic'" @submit.prevent="run(save)">
            <fieldset :disabled="busy">
              <div v-for="f in currentFields" :key="f.key" class="field">
                <label :for="'field-' + f.key"
                  >{{ f.label }}
                  <em
                    :class="{ required: f.required && (f.key !== 'participantIds' || form.lifecycle === 'active') }"
                    >{{
                      f.key === 'participantIds'
                        ? form.lifecycle === 'active'
                          ? '必填 · 至少一人'
                          : '可为空'
                        : f.required
                          ? '必填'
                          : '选填'
                    }}</em
                  ></label
                >
                <div class="field-control">
                  <template v-if="f.reference"
                    ><input
                      type="search"
                      :aria-label="'搜索' + f.label"
                      v-model="refSearch[f.key]"
                      placeholder="查找名称或 ID"
                    /><select
                      :id="'field-' + f.key"
                      v-model="form[f.key]"
                      :aria-invalid="invalidLocationField(f.key) || undefined"
                      :multiple="f.many"
                      :required="f.required && (!f.many || form.lifecycle === 'active')"
                    >
                      <option v-if="!f.many" value="">{{ f.required ? '请选择' : '未指定' }}</option>
                      <option v-for="o in options(f)" :key="o.id" :value="o.id">{{ o.name }} · {{ o.id }}</option>
                    </select>
                    <button v-if="f.reference === 'location' && quick !== f.key" type="button" @click="beginPlace(f)">
                      就地新建地点
                    </button>
                    <div v-if="quick === f.key" class="tools">
                      <input aria-label="新地点名称" v-model="quickName" @keydown.enter.prevent="addPlace(f)" /><button
                        type="button"
                        :disabled="!quickName.trim()"
                        @click="addPlace(f)"
                      >
                        创建并选用</button
                      ><button type="button" @click="quick = ''">取消</button>
                    </div></template
                  >
                  <select
                    v-else-if="f.choices"
                    :id="'field-' + f.key"
                    :aria-invalid="invalidLocationField(f.key) || undefined"
                    v-model="form[f.key]"
                  >
                    <option v-for="c in f.choices" :key="c" :value="c">{{ choiceNames[c] ?? c }}</option>
                  </select>
                  <textarea v-else-if="f.long" :id="'field-' + f.key" v-model="form[f.key]" rows="3"></textarea
                  ><input v-else :id="'field-' + f.key" :required="f.required" v-model="form[f.key]" />
                </div>
              </div>
              <div class="tools record-actions">
                <button class="primary" :disabled="!dirty">保存记录</button
                ><button v-if="dirty" type="button" @click="discardInput">放弃本次输入</button>
              </div>
            </fieldset>
          </form>
          <LocationOpening
            v-if="facet === 'basic' && record?.kind === 'location'"
            :key="record.id"
            ref="locationOpening"
            :location-id="record.id"
            :records="book.records"
            :refresh="refresh"
            @save="run(save)"
            @scene="id => locateOpeningField('scene', id, 'participantIds')"
            @actor="id => locateOpeningField('character', id, 'initialLocationId')"
          />
          <p v-if="draftNew && section === 'location'">保存地点后可选择开局参与互动的角色。</p>
          <div v-if="conflict" class="alert">
            <b>字段发生冲突 · {{ currentFields.find(f => f.key === conflict?.key)?.label }}</b>
            <p>已保存 {{ conflict.current }}　当前输入 {{ conflict.proposed }}</p>
            <button @click="resolveConflict(true)">保留当前输入</button
            ><button @click="resolveConflict(false)">采用已保存值</button>
          </div>
          <WorldSetupEditor
            v-if="record && facet === 'setup'"
            :key="record.id"
            ref="facetEditor"
            scoped-actor
            :initial-character="record.id"
            initial-kind="portrayal"
          />
          <StageEditor
            v-if="record && (facet === 'portrait' || facet === 'background')"
            :key="record.id"
            ref="facetEditor"
            :asset="{ kind: facet, id: record.id }"
          />
          <PluginConfigEditor
            v-if="record && facet === 'contacts'"
            :key="record.id"
            ref="facetEditor"
            mode="communication"
            scoped-actor
            :initial-character="record.id"
          />
          <LocationItems
            v-if="record && facet === 'items'"
            :key="record.id"
            ref="facetEditor"
            :location-id="record.id"
            :records="book.records"
            :refresh="refresh"
            @open="id => follow('item', id)"
          />
          <ItemUses
            v-if="record?.kind === 'item'"
            :key="record.id + '|' + record.values.locationId + '|' + itemUseVersion"
            :id="record.id"
            @open="openItemUse"
          />
          <RpgRecordFields
            v-if="record?.kind === 'item' || (record?.kind === 'character' && facet === 'rpg')"
            ref="rpgRecord"
            :key="record.id"
            :id="record.id"
            :kind="record.kind"
            :save-record="saveRecordForTrial"
            @character="id => choose('character', id, undefined, 'rpg')"
            @saved="itemUseVersion++"
          />
          <details
            v-if="record && (record.kind !== 'item' || inbound.length)"
            :key="record.id"
            @toggle="loadReaderRefs"
          >
            <summary>查看引用（{{ inbound.length + readerRefs.length + actorUses.length }}）</summary>
            <button v-for="r in readerRefs" :key="r.section + r.id" @click="choose(r.section, r.id)">
              {{ r.section === 'rules' ? '世界事件' : r.section === 'presets' ? '文风预设' : '知识库' }} › {{ r.label }}
            </button>
            <button
              v-for="r in actorUses"
              :key="[r.activity, r.choice, r.field].join('/')"
              @click="focusActivity(r.activity, r.choice, r.field, r.kind + '/' + r.id)"
            >
              {{ r.source }} › {{ r.fieldLabel }}
            </button>
            <p v-if="!inbound.length && !readerRefs.length && !actorUses.length">暂无引用。</p>
            <button v-for="r in inbound" :key="r.kind + r.id + r.field" @click="follow(r.kind, r.id, r.field)">
              {{ sections[r.kind] }} › {{ r.name }} › {{ r.label }}
            </button>
          </details>
          <details v-if="lastSave?.changes.length">
            <summary>上次保存 · {{ lastSave.saved.name }}（{{ lastSave.changes.length }}）</summary>
            <p v-for="c in lastSave.changes" :key="c.field">
              {{ fields[lastSave.saved.kind].find(f => f.key === c.field)?.label }} · {{ c.before || '空' }} →
              {{ c.after || '空' }}
            </p>
          </details>
        </section></template
      >
    </div>
  </main>
</template>
<style scoped>
.workbook {
  color-scheme: light;
  --work-ink: #202020;
  --work-muted: #626262;
  --work-line: #dedede;
  --work-mono: Consolas, 'SFMono-Regular', monospace;
  --primary: var(--work-ink);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f3f3f3;
  color: #2f2f2f;
  font:
    14px/1.55 'Source Sans 3',
    'Microsoft YaHei UI',
    sans-serif;
}
.mast,
.title,
.tools,
.entry {
  display: flex;
  gap: 10px;
  align-items: center;
}
.mast {
  background: #fff;
  border-bottom: 1px solid #ccc;
  padding: 8px 20px;
  gap: 18px;
}
.brand,
.mast .tools button,
.register-heading button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.brand {
  color: #222;
  white-space: nowrap;
  gap: 10px;
}
.brand b {
  font:
    700 21px Georgia,
    serif;
  letter-spacing: -1px;
}
.brand span {
  font-size: 12px;
  color: #5e5e5e;
  border-left: 1px solid #ccc;
  padding-left: 9px;
}
.workbook .mast .project-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  border: 0;
  background: transparent;
  color: #5a5a5a;
  font-size: 13px;
}
.mast .tools {
  margin-left: auto;
  gap: 3px;
}
.mast .tools button:not(.primary) {
  background: transparent;
  border-color: transparent;
}
.mast .tools button:not(.primary):hover,
.workbook .project-name:hover {
  background: #f2f2f2;
  color: var(--work-ink);
}
.mast .tools .primary {
  margin-left: 4px;
  font-weight: 650;
}

.workbook button,
.workbook input,
.workbook select,
.workbook textarea {
  font: inherit;
}
.workbook button {
  cursor: pointer;
  border: 1px solid #c5c5c5;
  border-radius: 4px;
  padding: 7px 12px;
  background: #fff;
  color: #3b3b3b;
}
.workbook button:disabled {
  opacity: 0.6;
  cursor: default;
}
.workbook .primary {
  background: var(--work-ink);
  color: #fff;
  border-color: var(--work-ink);
}
.workbook :focus-visible {
  outline: 2px solid #444;
  outline-offset: 2px;
}
.desk {
  display: grid;
  flex: 1;
  min-height: 0;
  grid-template-columns: clamp(162px, 16vw, 212px) clamp(208px, 20vw, 290px) minmax(0, 1fr);
}
.directory {
  padding: 21px 10px;
  border-right: 1px solid #d1d1d1;
  background: #f3f3f3;
  min-width: 0;
}
.directory-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #656565;
  font-size: 12px;
  font-weight: 650;
  padding: 0 8px 13px;
}
.directory .mobile-toggle {
  display: none;
}
.workbook .directory-problems {
  width: 100%;
  display: flex;
  justify-content: space-between;
  color: #9b2020;
  background: none;
  border: 0;
  border-top: 1px solid #ccc;
  margin-top: 16px;
  padding-top: 10px;
}
.nav-group {
  margin-bottom: 4px;
}
.group-heading {
  display: flex;
  align-items: center;
  border-radius: 4px;
}
.group-heading:has([aria-current='page']) {
  background: #dfdfdf;
  box-shadow: inset 3px 0 var(--work-ink);
}
.nav-group:has(.child-links [aria-current='page']) .group-heading button:first-child,
.directory .group-heading button[aria-current='page'] {
  color: var(--work-ink);
  font-weight: 700;
}
.directory .group-heading button,
.directory .child-links button {
  display: flex;
  align-items: center;
  gap: 9px;
  text-align: left;
  background: transparent;
  border: 0;
}
.group-heading button:first-child {
  flex: 1;
  font-weight: 550;
  padding: 9px 10px;
}
.directory .disclosure {
  padding: 9px 6px;
  color: #666;
}
.disclosure[aria-expanded='false'] svg {
  transform: rotate(-90deg);
}
.child-links {
  margin: 4px 5px 10px 15px;
  padding-left: 7px;
  border-left: 1px solid #ccc;
}
.directory .child-links button {
  width: 100%;
  justify-content: space-between;
  padding: 5px 7px;
  font-size: 13px;
}
.directory .child-links button[aria-current='page'] {
  background: #dfdfdf;
  box-shadow: inset 2px 0 var(--work-ink);
  font-weight: 650;
}
.child-links button:hover,
.group-heading:not(:has([aria-current='page'])):hover {
  background: #e7e7e7;
}
.register,
.inspector {
  min-width: 0;
}
.register {
  border-right: 1px solid #d5d5d5;
  padding: 22px 13px;
  background: #fafafa;
}
.register-heading,
.title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.register-heading h2 {
  font-size: 18px;
  line-height: 1.35;
  font-weight: 700;
  margin: 0;
}
.register-heading h2 small {
  font-size: 12px;
  margin-left: 3px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.workbook .register-heading button {
  font-size: 12px;
  padding: 4px 7px;
  white-space: nowrap;
}
.workbook .record-search {
  display: flex;
  align-items: center;
  gap: 6px;
  background: white;
  border: 1px solid #ccc;
  border-radius: 4px;
  padding: 0 7px;
  margin: 14px 0 5px;
  color: #777;
}
.workbook .record-search input {
  border: 0;
  background: none;
  padding: 7px 0;
  min-width: 0;
}
.inspector {
  padding: clamp(22px, 2.7vw, 44px);
  background: white;
  container-type: inline-size;
}
.inspector .title {
  border-bottom: 1px solid var(--work-line);
  padding-bottom: 17px;
  margin-bottom: 18px;
}
.title:has(+ .facet-nav) {
  border: 0;
  padding-bottom: 0;
  margin-bottom: 14px;
}
.title small,
.rows small {
  font: 12px/1.5 var(--work-mono);
  overflow-wrap: anywhere;
}
.title > div,
.rows b {
  min-width: 0;
  overflow-wrap: anywhere;
}
.title small {
  display: block;
  margin-top: 5px;
}
.title h1 {
  font-size: clamp(26px, 2.5vw, 36px);
  font-weight: 700;
  letter-spacing: -0.025em;
  margin: 0;
  line-height: 1.22;
}
.facet-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  border-bottom: 1px solid #d4d4d4;
  margin: 0 0 22px;
}
.workbook .facet-nav button {
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  padding: 8px 10px;
  color: #666;
}
.workbook .facet-nav button[aria-pressed='true'] {
  border-color: #252525;
  color: #222;
  font-weight: 650;
}
.inspector > form,
.inspector > .opening-members,
.inspector > .placed {
  max-width: 52rem;
}
.rows {
  margin-top: 12px;
}
.rows button {
  display: grid;
  text-align: left;
  width: 100%;
  border: 0;
  border-bottom: 1px solid #dfdfdf;
  border-radius: 0;
  background: transparent;
  gap: 2px;
  padding: 10px 12px;
}
.rows button:hover {
  background: #f0f0f0;
}
.rows button[aria-pressed='true'] {
  background: #e6e6e6;
  box-shadow: inset 3px 0 var(--work-ink);
}
.rows b {
  font-size: 15px;
  font-weight: 600;
}
.rows button[aria-pressed='true'] b {
  font-weight: 700;
}
.workbook small,
.workbook em {
  color: #636363;
}
.workbook em {
  font-size: 12px;
  font-style: normal;
  margin-left: 5px;
}
.inspector,
.dialog,
.entry button {
  background: #fff;
}
.title {
  justify-content: space-between;
}
.workbook fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.workbook label,
.field {
  display: block;
  margin-bottom: 7px;
}
.field {
  padding-block: 10px;
  border-bottom: 1px solid var(--work-line);
  margin: 0;
}
.field:first-child {
  padding-top: 0;
}
.field > label {
  font-weight: 650;
  color: var(--work-ink);
  margin-bottom: 5px;
}
.field em {
  font-weight: 400;
}
.field em.required {
  font-weight: 600;
  color: #404040;
}
.field-control {
  min-width: 0;
}
.field-control > button {
  background: transparent;
  font-size: 12px;
  padding: 3px 7px;
}
.record-actions {
  margin-top: 14px;
}
.record-actions .primary:disabled {
  color: #5d5d5d;
  background: #ededed;
  border-color: #d5d5d5;
  opacity: 1;
}
@container (min-width: 520px) {
  .field {
    display: grid;
    grid-template-columns: 118px minmax(0, 1fr);
    gap: 14px;
  }
  .field > label {
    margin: 0;
    padding-top: 8px;
  }
}

.workbook input,
.workbook select,
.workbook textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #c3c3c3;
  border-radius: 4px;
  background: #fff;
  color: #2f2f2f;
}
.field input[type='search'] {
  margin-bottom: 4px;
}
.field button {
  margin-top: 6px;
}
.tools {
  flex-wrap: wrap;
}
.tools input {
  flex: 1;
  min-width: 100px;
}
.workbook details {
  border-top: 1px solid #dbdbdb;
  margin-top: 16px;
  padding-top: 10px;
}
.workbook summary {
  cursor: pointer;
  font-weight: 600;
}
.activities {
  grid-column: 2/-1;
  min-width: 0;
}
.save-status,
.alert {
  padding: 10px 24px;
  margin: 0;
}
.alert {
  background: #fff5f5;
  color: #912020;
  border-inline-start: 3px solid #ae3030;
}
.save-status {
  background: #ebebeb;
}
.home,
.dialog {
  max-width: 720px;
  margin: 6vh auto;
  padding: 28px;
}
.home h1,
.dialog h1 {
  font-size: 30px;
  margin-bottom: 24px;
}
.entry button {
  flex: 1;
  text-align: left;
  padding: 22px;
}
.entry b,
.entry span {
  display: block;
}
.entry b {
  font-size: 20px;
}
.entry span {
  margin-top: 10px;
}
.dialog .close {
  float: right;
}
.dialog label {
  margin-top: 14px;
}
.dialog label input {
  display: block;
}
.transcript p {
  margin: 7px 0;
}
.transcript b {
  margin-right: 6px;
}
.mast {
  flex-wrap: wrap;
}
.workbook > .mast {
  flex-shrink: 0;
}
@media (min-width: 861px) {
  .workbook:has(.desk:not(.flow)):not(:has(.dialog)) {
    height: 100dvh;
    min-height: 0;
  }
  .desk:not(.flow) {
    grid-template-rows: minmax(0, 1fr);
  }
  .desk:not(.flow) > * {
    overflow: auto;
    scrollbar-gutter: stable;
  }
}
@media (max-width: 860px) {
  .desk:not(.flow) {
    grid-template-columns: minmax(170px, 28%) minmax(0, 1fr);
    align-content: start;
  }
  .directory {
    grid-column: 1/-1;
    padding: 7px 14px;
    border-bottom: 1px solid #ccc;
  }
  .directory-head {
    padding: 0;
  }
  .directory .mobile-toggle {
    display: inline-flex;
    gap: 7px;
    align-items: center;
    background: #fff;
  }
  .directory:not(.expanded) .work-groups {
    display: none;
  }
  .work-groups {
    margin-top: 10px;
  }
  .activities {
    grid-column: 1/-1;
  }
  .workbook .mast {
    gap: 8px;
    padding: 8px 12px;
  }
  .mast .project-name {
    display: none;
  }
}
@media (max-width: 570px) {
  .desk:not(.flow) {
    display: block;
  }
  .register,
  .inspector {
    padding: 14px;
  }
  .register {
    border-right: 0;
    border-bottom: 1px solid #ccc;
  }
  .rows {
    max-height: 142px;
    overflow: auto;
  }
  .entry {
    align-items: stretch;
    flex-direction: column;
  }
  .mast .tools {
    margin-left: 0;
  }
  .workbook .mast .tools button {
    padding: 5px 7px;
    font-size: 12px;
  }
}
.desk.flow {
  display: block;
  min-height: 100dvh;
}
.flow .activities {
  width: 100%;
}
.workbook .player-role {
  display: inline-block;
  background: #454545;
  color: #fff;
  border-radius: 3px;
  padding: 1px 5px;
  margin-inline-start: 3px;
  vertical-align: 1px;
  font-size: 11px;
  font-weight: 500;
}
.workbook .location-warning {
  color: #9b2020;
  font-size: 12px;
}
.workbook select[aria-invalid='true'] {
  border-color: #ae3030;
  outline-color: #ae3030;
  color: #9b2020;
}
</style>
