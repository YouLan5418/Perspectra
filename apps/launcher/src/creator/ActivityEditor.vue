<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import {
  variableCandidates,
  conditionLeaves,
  conditionCatalog,
  type ConditionLeaf,
  type Scalar,
  parseVariable,
  type EditorVariable,
  type LocalVariable,
} from '@perspectra/world-pack/editor-fields'
import ActivityCanvas from './ActivityCanvas.vue'
import FlowGroupForm from './FlowGroupForm.vue'
import ActivityReferences from './ActivityReferences.vue'
import { activityReferences, type ActivityReference } from '@perspectra/host/editor/activity-references'
import type { LayoutNode } from '../../../host/src/editor/activity-graph.ts'
const props = defineProps<{ active?: boolean }>()
import ChoiceRuling from './ChoiceRuling.vue'
import RpgCueFlow from './RpgCueFlow.vue'
import type { rpgBook } from '../../../host/src/editor/rpg.ts'
const rpgLoadError = ref('')
const rpgActivities = ref<ReturnType<typeof rpgBook>['activities']>([])
const rpgKey = ref(''),
  rpgMap = computed(() => rpgActivities.value.find(a => a.key === rpgKey.value))
const emit = defineEmits<{
  overview: []
  definition: [reference: ActivityReference]
  script: [id: string]
  gameplay: [location: string, field?: string]
  page: [key: string]
  knowledge: [id: string]
}>()
import ScalarField from './ScalarField.vue'
import VariableFields from './VariableFields.vue'
import { editorRequest } from './editor-api.ts'
import type { EditorGraph, EditorChoice, ChoiceCondition } from '../../../host/src/editor/activity-graph.ts'
import type { EditorProject } from '../../../host/src/editor/project.ts'
import type { playActivity } from '../../../host/src/editor/export.ts'

const project = ref<EditorProject>(),
  graph = ref<EditorGraph>(),
  base = ref<EditorGraph | null>(null)
const selected = ref(''),
  busy = ref(false),
  message = ref(''),
  error = ref(''),
  newKey = ref(''),
  creating = ref(false)
const drawer = ref<'' | 'properties' | 'new' | 'group' | 'library' | 'references' | 'trial'>('')
const scope = ref(''),
  groupId = ref(''),
  addingGroup = ref(false)
const references = computed(() =>
  project.value
    ? activityReferences(project.value, [
        ...project.value.graphs.filter(g => g.key !== graph.value?.key),
        ...(graph.value ? [graph.value] : []),
      ])
    : [],
)
const localOrigin = ref<ActivityReference>()
const ownRefs = computed(() =>
  references.value.filter(r => r.activity === graph.value?.key && r.choice === selected.value),
)
function replaceLayout(rows: LayoutNode[]) {
  if (!graph.value) return
  if (rows.length) graph.value.layout = rows
  else delete graph.value.layout
}
function place(id: string, x: number, y: number) {
  const rows = graph.value?.layout ?? []
  const item = rows.find(n => n.id === id)
  if (item) {
    item.x = x
    item.y = y
  } else replaceLayout([...rows, { id, x, y }])
}
function openPanel(panel: typeof drawer.value) {
  if (localDraft.value && drawer.value === 'properties' && panel !== 'properties') {
    error.value = '请先保存或取消变量定义'
    return false
  }
  drawer.value = panel
  return true
}
function editNode(id: string) {
  if (localDraft.value && selected.value !== (id === 'start' ? '' : id)) {
    error.value = '请先保存或取消变量定义'
    return
  }
  localOrigin.value = undefined
  selectChoice(id === 'start' ? '' : id)
  drawer.value = 'properties'
}
function drill(id: string) {
  if (openPanel('')) scope.value = id
}
function newNode() {
  if (openPanel('new')) addingGroup.value = false
}
function showRpg(key: string) {
  rpgKey.value = key
  drawer.value = ''
}
function editGroup(id: string) {
  if (openPanel('group')) groupId.value = id
}
function applyGroup(rows: LayoutNode[], dissolved = false) {
  const parent = graph.value?.layout?.find(n => n.id === groupId.value)?.parent ?? ''
  replaceLayout(rows)
  if (dissolved && scope.value === groupId.value) scope.value = parent
  drawer.value = ''
}
async function jumpSource(r: ActivityReference) {
  if (graph.value?.key !== r.activity) {
    await selectGraph(r.activity)
    if (graph.value?.key !== r.activity) return
  }
  editNode(r.choice)
  await nextTick()
  focusField(r.field, r.kind + '/' + r.id)
}
async function openTarget(r: ActivityReference) {
  if (localDraft.value) {
    error.value = '请先保存或取消变量定义'
    return
  }
  if (r.kind !== 'local') {
    emit('definition', r)
    return
  }
  if (graph.value?.key !== r.scope) await selectGraph(r.scope)
  if (graph.value?.key !== r.scope) return
  const v = graph.value?.variables?.find(v => v.key === r.id)
  if (v) {
    editNode('start')
    localOrigin.value = r
    editVariable('definition', v)
  }
}
const conditionControl = ref<HTMLSelectElement>(),
  search = ref(''),
  locations = ref<Record<string, string>>({})
const preview = ref<Awaited<ReturnType<typeof playActivity>>>()
type Conflict = {
  field: string
  current?: unknown
  proposed?: unknown
}
const conflict = ref<Conflict>()
const choice = computed(() => graph.value?.choices.find(c => c.id === selected.value))
const rowIndex = ref(0),
  addingCondition = ref(false)
const leaves = computed(() => (choice.value ? conditionLeaves(choice.value.condition) : []))
const activeLeaf = computed(() => (addingCondition.value ? undefined : leaves.value[rowIndex.value]))
const takeItems = ref<string[]>([]),
  startWorld = ref<Record<string, Scalar>>({})
const trialLeaves = computed(() => graph.value?.choices.flatMap(c => conditionLeaves(c.condition)) ?? [])
const trialItems = computed(
  () => project.value?.items.filter(i => trialLeaves.value.some(c => c.kind === 'held' && c.ref === i.id)) ?? [],
)
const trialWorld = computed(
  () =>
    project.value?.rules.variables.filter(
      v => v.readable && trialLeaves.value.some(c => c.kind === 'world' && c.ref === v.key),
    ) ?? [],
)
watch(selected, () => activateRow(0), { flush: 'sync' })
watch(
  [takeItems, startWorld, locations],
  () => {
    preview.value = undefined
  },
  { deep: true },
)
function activateRow(index: number) {
  rowIndex.value = index
  addingCondition.value = false
  search.value = ''
}
const choiceIndex = computed(() => graph.value?.choices.findIndex(c => c.id === selected.value) ?? -1)
const dirty = computed(() => JSON.stringify(graph.value) !== JSON.stringify(base.value))
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
function replaceGraph(g: EditorGraph) {
  const previous = activeLeaf.value
  graph.value = clone(g)
  const rows = leaves.value
  if (previous && JSON.stringify(rows[rowIndex.value]) === JSON.stringify(previous)) return
  const same = previous ? rows.findIndex(row => JSON.stringify(row) === JSON.stringify(previous)) : -1
  const index = same >= 0 ? same : Math.max(0, Math.min(rowIndex.value, rows.length - 1))
  if (index !== rowIndex.value || (addingCondition.value && choice.value?.condition.kind === 'always'))
    activateRow(index)
}
function load(g: EditorGraph | null, key = '') {
  localOrigin.value = undefined
  drawer.value = ''
  scope.value = ''
  activateRow(0)
  takeItems.value = []
  startWorld.value = {}
  rpgKey.value = ''
  base.value = g ? clone(g) : null
  graph.value = g ? clone(g) : { key, title: '新活动', opening: '', choices: [] }
  selected.value = graph.value.choices[0]?.id ?? ''
  preview.value = undefined
  localDraft.value = undefined
  localRefs.value = []
  conflict.value = undefined
  search.value = ''
}
async function work(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = (e as Error).message
    const failure = e as { status?: number; details?: typeof conflict.value }
    if (failure.status === 409) conflict.value = failure.details
  } finally {
    busy.value = false
  }
}
async function refresh() {
  project.value = await editorRequest<EditorProject>('open')
  try {
    rpgActivities.value = (await editorRequest<ReturnType<typeof rpgBook>>('gameplay')).activities
    rpgLoadError.value = ''
  } catch (e) {
    rpgActivities.value = []
    rpgLoadError.value = (e as Error).message
  }
}
async function save() {
  if (!graph.value) return
  if (!dirty.value) {
    await refresh()
    const latest = project.value?.graphs.find(g => g.key === graph.value?.key)
    if (!latest) throw new Error('此活动已被外部删除，请重新打开作品。')
    base.value = clone(latest)
    replaceGraph(latest)
    conflict.value = undefined
    if (selected.value && !latest.choices.some(c => c.id === selected.value))
      selected.value = latest.choices[0]?.id ?? ''
    return
  }
  const edit = { graph: graph.value, base: base.value }
  const saved = await editorRequest<EditorGraph>('save', edit)
  base.value = clone(saved)
  replaceGraph(saved)
  conflict.value = undefined
  await refresh()
}
async function selectGraph(key: string) {
  await work(async () => {
    await save()
    const g = project.value?.graphs.find(g => g.key === key)
    if (g) load(g)
  })
}
async function create() {
  await work(async () => {
    const key = newKey.value.trim()
    if (
      !/^[a-z][a-z0-9-]{0,40}$/.test(key) ||
      project.value?.graphs.some(g => g.key === key) ||
      project.value?.scripts.includes(key)
    )
      throw new Error('请输入未使用的小写活动标识')
    await save()
    load(null, key)
    creating.value = false
    newKey.value = ''
  })
}
function appendChoice() {
  if (!graph.value) return
  const item: EditorChoice = {
    id: 'choice-' + crypto.randomUUID().replaceAll('-', ''),
    label: '新选项',
    result: '',
    speech: '',
    next: 'end',
    condition: { kind: 'always' },
  }
  graph.value.choices.push(item)
  if (scope.value) replaceLayout([...(graph.value.layout ?? []), { id: item.id, parent: scope.value }])
  drawer.value = 'properties'
  selected.value = item.id
  search.value = ''
}
function moveChoice(offset: -1 | 1) {
  const choices = graph.value?.choices,
    i = choiceIndex.value
  if (!choices || i < 0 || !choices[i + offset]) return
  const [item] = choices.splice(i, 1)
  choices.splice(i + offset, 0, item!)
}
function removeChoice() {
  const choices = graph.value?.choices,
    i = choiceIndex.value
  if (!choices || i < 0) return
  replaceLayout((graph.value?.layout ?? []).filter(n => n.id !== selected.value))
  choices.splice(i, 1)
  selectChoice(choices[i]?.id ?? choices[i - 1]?.id ?? '')
}
const variableRows = (field: 'condition' | 'effect') =>
  variableCandidates(project.value?.rules.variables ?? [], graph.value?.variables ?? [], graph.value?.key ?? '', field)
const variableDef = (field: 'condition' | 'effect') => {
  const use = field === 'condition' ? activeLeaf.value : choice.value?.effect
  return use && variableRows(field).find(v => v.kind === use.kind && v.key === ('ref' in use ? use.ref : ''))
}
function selectVariable(value: string, field: 'condition' | 'effect') {
  const c = choice.value
  if (!c) return
  const v = variableRows(field).find(v => v.kind + '/' + v.key === value)
  if (v) {
    const use = { kind: v.kind, ref: v.key, value: v.initial }
    if (field === 'effect') c.effect = use
    else writeCondition(use)
  } else if (field === 'effect') delete c.effect
}
const localDraft = ref<EditorVariable>(),
  variableScope = ref<'world' | LocalVariable['scope']>('shared'),
  variableField = ref<'condition' | 'effect' | 'definition'>('definition'),
  oldVariable = ref('')
function editVariable(field: 'condition' | 'effect' | 'definition', v?: LocalVariable) {
  variableField.value = field
  variableScope.value = v?.scope ?? (field === 'definition' ? 'shared' : 'world')
  oldVariable.value = v?.key ?? ''
  localDraft.value = v ? clone(v) : { key: '', label: search.value, type: 'boolean', initial: false }
}
async function keepVariable() {
  await work(async () => {
    if (!graph.value || !localDraft.value) return
    const v = parseVariable(localDraft.value)
    if (variableScope.value === 'world') {
      await editorRequest('rule-save', { kind: 'variable', base: null, row: v })
      await refresh()
    } else {
      const vars = graph.value.variables ?? []
      if (!oldVariable.value && vars.some(x => x.key === v.key)) throw new Error('本活动已有同键变量')
      graph.value.variables = [...vars.filter(x => x.key !== oldVariable.value), { ...v, scope: variableScope.value }]
    }
    if (variableField.value !== 'definition')
      selectVariable((variableScope.value === 'world' ? 'world/' : 'local/') + v.key, variableField.value)
    localDraft.value = undefined
    if (variableField.value === 'definition') await save()
  })
}
const localRefs = ref<{ section: string; label: string; id: string; choice?: string; field: string }[]>([])
const localRefKey = ref('')
async function usesOfLocal(key: string) {
  await work(async () => {
    await save()
    localRefs.value = await editorRequest('rule-references', { kind: 'local', id: key, activity: graph.value!.key })
    localRefKey.value = key
    message.value = localRefs.value.length ? '' : '这个活动变量尚无引用'
  })
}
async function focusLocal(r: { section: string; id: string; choice?: string; field: string }) {
  if (r.section === 'knowledge') {
    emit('knowledge', r.id)
    return
  }
  if (!r.choice) return
  editNode(r.choice)
  await nextTick()
  focusField(r.field, 'local/' + localRefKey.value)
}
const rulingControl = ref<InstanceType<typeof ChoiceRuling>>()
function focusField(field: string, reference?: string) {
  if (field.startsWith('condition')) {
    let index = Number(field.split('/')[1] ?? 0)
    const matches = (leaf: ConditionLeaf) =>
      'ref' in leaf && (leaf.kind === 'party' ? 'present' : leaf.kind) + '/' + leaf.ref === reference
    const row = leaves.value[index]
    if (!row || (reference && !matches(row))) {
      const remaining = leaves.value.flatMap((leaf, i) => (matches(leaf) ? [i] : []))
      if (remaining.length !== 1) {
        activateRow(0)
        error.value = '这条条件引用已更改，请核对当前分支。'
        return
      }
      index = remaining[0]!
    }
    activateRow(index)
  }
  if (
    reference &&
    !field.startsWith('condition') &&
    !ownRefs.value.some(r => r.field === field && r.kind + '/' + r.id === reference)
  ) {
    error.value = '这条引用已更改，请核对当前选项。'
    return
  }
  if (field === 'ruling' || field === 'script') rulingControl.value?.focus(field)
  else (field === 'effect' ? effectControl : conditionControl).value?.focus()
}
const effectControl = ref<HTMLSelectElement>()
const conditions = computed(() => {
  const q = search.value.trim().toLowerCase(),
    p = project.value
  const rows = [
    ...(!addingCondition.value && leaves.value.length === 1 ? [{ value: 'always', label: '始终可选', key: '' }] : []),
    { value: 'alone', label: '玩家独自在场', key: '' },
    ...(p?.characters ?? []).map(c => ({ value: 'present/' + c.id, label: c.name + '在场', key: c.id })),
    ...(p?.characters ?? []).map(c => ({ value: '!present/' + c.id, label: c.name + '不在场', key: c.id })),
    ...(p?.partyCharacters ?? []).map(c => ({ value: 'party/' + c.id, label: c.name + '在场且随队', key: c.id })),
    ...(p?.locations ?? []).flatMap(l => [
      { value: 'location/' + l.id, label: '玩家在' + l.name, key: l.id },
      { value: '!location/' + l.id, label: '玩家不在' + l.name, key: l.id },
    ]),
    ...variableRows('condition').map(v => ({
      value: v.kind + '/' + v.key,
      label: (v.kind === 'world' ? '世界' : '本活动') + ' · ' + v.label,
      key: v.key,
    })),
    ...(p?.items ?? []).map(i => ({ value: 'held/' + i.id, label: '玩家持有' + i.name, key: i.id })),
  ]
  return rows.filter(r => r.value === conditionValue.value || (r.label + ' ' + r.key).toLowerCase().includes(q))
})
const conditionValue = computed(() => {
  if (addingCondition.value) return ''
  const c = activeLeaf.value
  return c && 'ref' in c ? ('negate' in c && c.negate ? '!' : '') + c.kind + '/' + c.ref : (c?.kind ?? 'always')
})
function writeCondition(leaf: ConditionLeaf) {
  const c = choice.value
  if (!c) return
  if ('conditions' in c.condition) {
    if (leaf.kind === 'always') return
    if (addingCondition.value) c.condition.conditions.push(leaf)
    else c.condition.conditions[rowIndex.value] = leaf
  } else if (addingCondition.value && c.condition.kind !== 'always' && leaf.kind !== 'always') {
    c.condition = { kind: 'all', conditions: [c.condition, leaf] }
  } else c.condition = leaf
  activateRow(addingCondition.value ? conditionLeaves(c.condition).length - 1 : rowIndex.value)
}
function removeCondition() {
  const c = choice.value
  if (!c || !('conditions' in c.condition)) return
  const rows = c.condition.conditions
  rows.splice(rowIndex.value, 1)
  if (rows.length === 1) c.condition = rows[0]!
  activateRow(Math.min(rowIndex.value, rows.length - 1))
}
function beginCondition() {
  addingCondition.value = true
  search.value = ''
  void nextTick(() => conditionControl.value?.focus())
}
function setCondition(value: string) {
  if (!choice.value) return
  const [kind, ...id] = value.split('/')
  if (kind === 'world' || kind === 'local') {
    selectVariable(value, 'condition')
    return
  }
  if (kind === 'always' || kind === 'alone') writeCondition({ kind })
  else if (kind === '!location' || kind === '!present')
    writeCondition({ kind: kind === '!location' ? 'location' : 'present', negate: true, ref: id.join('/') })
  else if (kind === 'held' || kind === 'present' || kind === 'location' || kind === 'party')
    writeCondition({ kind, ref: id.join('/') })
}
function assignmentLabel(use: NonNullable<EditorChoice['effect']>) {
  const v = variableRows('effect').find(r => r.kind === use.kind && r.key === use.ref)
  return (v?.label ?? use.ref) + ' = ' + String(use.value)
}
function describe(c: ChoiceCondition): string {
  if ('conditions' in c)
    return (
      (c.kind === 'all' ? '全部满足：' : '满足任一：') +
      c.conditions.map(describe).join(c.kind === 'all' ? ' 且 ' : ' 或 ')
    )
  if (c.kind === 'always') return '始终可选'
  if (c.kind === 'alone') return '玩家独自在场'
  if (c.kind === 'world' || c.kind === 'local')
    return (
      (variableRows('condition').find(v => v.kind === c.kind && v.key === c.ref)?.label ?? c.ref) +
      ' = ' +
      String(c.value)
    )
  const refs = project.value?.[conditionCatalog[c.kind]]
  const name = refs?.find(r => r.id === c.ref)?.name ?? c.ref
  if (c.kind === 'location') return (c.negate ? '玩家不在' : '玩家在') + name
  if (c.kind === 'party') return name + '在场且随队'
  return c.kind === 'held' ? '玩家持有' + name : name + ('negate' in c && c.negate ? '不在场' : '在场')
}
async function run(id?: string) {
  await work(async () => {
    await save()
    if (!graph.value) return
    preview.value = undefined
    preview.value = await editorRequest('play', {
      key: graph.value.key,
      expected: graph.value,
      scenes: locations.value,
      take: takeItems.value.filter(id => trialItems.value.some(i => i.id === id)),
      world: Object.fromEntries(
        Object.entries(startWorld.value).filter(([key]) => trialWorld.value.some(v => v.key === key)),
      ),
      ...(id ? { choice: id } : {}),
    })
  })
}
function selectChoice(id: string) {
  selected.value = id
  scope.value = graph.value?.layout?.find(n => n.id === id)?.parent ?? ''
  search.value = ''
}
function locate(id: string) {
  if (!graph.value?.choices.some(c => c.id === id)) {
    error.value = '这个选项已被删除。请重新试玩以更新记录。'
    return
  }
  editNode(id)
  activateRow(0)
  void nextTick(() => conditionControl.value?.focus())
}
function setLocation(character: string, scene: string) {
  if (scene) locations.value[character] = scene
  else delete locations.value[character]
}
function toggleWorldStart(v: EditorVariable, enabled: boolean) {
  const values = { ...startWorld.value }
  if (enabled) values[v.key] = v.initial
  else delete values[v.key]
  startWorld.value = values
}
async function exportSource() {
  await work(async () => {
    await save()
    const r = await editorRequest<{ directory: string }>('export')
    message.value = '已导出到 ' + r.directory
  })
}
async function reloadConflict(useLocal: boolean) {
  await work(async () => {
    const c = conflict.value,
      g = graph.value
    if (!c || !g) return
    const path = c.field.split('/')
    const field = path.at(-1)!
    const id = path[1]
    if (base.value && field === 'layout' && path.length === 1) {
      for (const target of useLocal ? [base.value] : [base.value, g]) {
        if (c.current) target.layout = clone(c.current as LayoutNode[])
        else delete target.layout
      }
    } else if (base.value && field === 'variables' && path.length === 1) {
      for (const target of useLocal ? [base.value] : [base.value, g]) {
        if (c.current) target.variables = clone(c.current as LocalVariable[])
        else delete target.variables
      }
    } else if (base.value && path.length === 1 && (field === 'title' || field === 'opening')) {
      base.value[field] = String(c.current)
      if (!useLocal) g[field] = String(c.current)
    } else if (base.value && id && path.length === 3) {
      const old = base.value.choices.find(x => x.id === id),
        own = g.choices.find(x => x.id === id)
      if (old) Object.assign(old, { [field]: c.current })
      if (own && !useLocal) Object.assign(own, { [field]: c.current })
    } else if (base.value && id && Array.isArray(c.current) && id === 'order') {
      const ids = c.current as string[]
      for (const target of useLocal ? [base.value] : [base.value, g]) {
        const reordered = ids.flatMap(key => target.choices.filter(item => item.id === key))
        target.choices = target.choices.map(item => (ids.includes(item.id) ? reordered.shift()! : item))
      }
    } else if (base.value && id && path.length === 2) {
      for (const target of useLocal ? [base.value] : [base.value, g]) {
        const pos = target.choices.findIndex(item => item.id === id)
        if (c.current)
          target.choices.splice(
            pos < 0 ? target.choices.length : pos,
            pos < 0 ? 0 : 1,
            clone(c.current as EditorChoice),
          )
        else {
          if (pos >= 0) target.choices.splice(pos, 1)
          if (target.layout) target.layout = target.layout.filter(n => n.id !== id)
        }
      }
    } else {
      if (useLocal) throw new Error('该记录整体已变动，请先复制需要保留的文字，再载入最新草稿。')
      await refresh()
      load(project.value?.graphs.find(v => v.key === g.key) ?? null, g.key)
      return
    }
    conflict.value = undefined
    await save()
  })
}
defineExpose({
  refresh,
  async openActivity(key?: string) {
    await ready
    await refresh()
    const record = project.value?.graphs.find(g => g.key === (key ?? graph.value?.key))
    if (record) load(record)
    if (!key) drawer.value = 'library'
  },
  focusField,
  async openChoice(key: string, id: string) {
    await ready
    await refresh()
    const g = project.value?.graphs.find(g => g.key === key)
    if (!g?.choices.some(c => c.id === id)) throw new Error('引用的选项已更改，请刷新后重新定位')
    load(g)
    editNode(id)
  },
  async flush() {
    if (localDraft.value) throw new Error('请先保存或取消正在填写的变量')
    if (busy.value) throw new Error('请等当前活动操作完成')
    if (conflict.value) throw new Error('请先处理活动里的并发修改')
    if (dirty.value) await save()
  },
})
const isActive = () => props.active !== false
let polling = false
async function syncExternal() {
  if (polling || document.hidden || !isActive() || busy.value || conflict.value || !project.value) return
  polling = true
  const original = base.value,
    prior = graph.value?.key
  try {
    const latest = await editorRequest<EditorProject>('open')
    if (!isActive() || original !== base.value || graph.value?.key !== prior || busy.value || conflict.value) return
    project.value = latest
    const changed = latest.graphs.find(g => g.key === prior)
    if (changed && JSON.stringify(changed) !== JSON.stringify(original)) {
      localDraft.value = undefined
      replaceGraph(changed)
      base.value = clone(changed)
      preview.value = undefined
      if (selected.value && !changed.choices.some(c => c.id === selected.value)) {
        selected.value = ''
        drawer.value = ''
      }
      if (scope.value && !changed.layout?.some(n => n.id === scope.value)) scope.value = ''
      if (drawer.value === 'group' || drawer.value === 'new') drawer.value = ''
      if (drawer.value === 'properties') scope.value = changed.layout?.find(n => n.id === selected.value)?.parent ?? ''
      message.value = '已载入外部保存的活动'
    } else if (original && !changed) {
      if (latest.graphs[0]) load(latest.graphs[0])
      else {
        graph.value = undefined
        base.value = null
        scope.value = ''
        drawer.value = 'library'
        localDraft.value = undefined
      }
      message.value = '活动已被外部移除'
    }
  } catch (e) {
    if (isActive()) error.value = (e as Error).message
  } finally {
    polling = false
  }
}
let timer: number
onBeforeUnmount(() => {
  clearInterval(timer)
  window.removeEventListener('focus', syncExternal)
  document.removeEventListener('visibilitychange', syncExternal)
})
let ready: Promise<void>
onMounted(() => {
  window.addEventListener('focus', syncExternal)
  document.addEventListener('visibilitychange', syncExternal)
  timer = window.setInterval(syncExternal, 4000)
  ready = work(async () => {
    await refresh()
    const first = project.value?.graphs[0]
    if (first) load(first)
    else {
      creating.value = true
      drawer.value = 'library'
    }
  })
})
</script>
<template>
  <main class="activity-editor" @keydown.esc="openPanel('')">
    <header>
      <div class="breadcrumb">
        <button :disabled="busy" @click="emit('overview')">← 作品总览</button><span>/</span
        ><b>{{ rpgMap?.title ?? graph?.title ?? '作品活动' }}</b>
      </div>
      <button :disabled="busy" @click="openPanel('library')">活动目录</button>
      <div v-if="!rpgMap" class="actions">
        <button :disabled="busy || !graph" @click="newNode">＋ 新增节点</button>
        <button :disabled="busy" @click="openPanel('references')">
          引用<span v-if="references.some(r => !r.valid)"> · 有问题</span>
        </button>
        <small>{{ graph ? (dirty ? '有未保存修改' : '草稿已保存') : '' }}</small
        ><button
          :disabled="busy || !graph"
          @click="
            work(async () => {
              await save()
              message = '草稿已保存'
            })
          "
        >
          保存草稿</button
        ><button :disabled="busy || !graph" @click="exportSource">导出源包</button
        ><button class="primary" :disabled="busy || !graph" @click="openPanel('trial') && run()">试玩活动</button>
      </div>
    </header>
    <p v-if="error" role="alert" class="notice">{{ error }}</p>
    <div v-if="conflict" class="notice">
      我的输入 {{ conflict.proposed }}　已保存 {{ conflict.current }}
      <button @click="reloadConflict(true)">保留我的输入</button
      ><button @click="reloadConflict(false)">采用已保存版本</button>
    </div>
    <p v-if="message || busy" role="status" class="notice">{{ busy ? '正在处理…' : message }}</p>
    <fieldset :disabled="busy" class="workspace">
      <aside v-if="drawer === 'library'" aria-label="活动目录">
        <div class="drawer-head">
          <h2>作品活动</h2>
          <button @click="openPanel('')">关闭</button>
        </div>
        <button
          v-for="g in project?.graphs"
          :key="g.key"
          :aria-pressed="!rpgMap && g.key === graph?.key"
          @click="selectGraph(g.key)"
        >
          {{ g.title }}
        </button>
        <button @click="creating = !creating">＋ 新建活动</button>
        <form v-if="creating" @submit.prevent="create">
          <label>活动标识<input v-model="newKey" required placeholder="read-note" /></label><button>创建</button>
        </form>
        <p v-if="rpgLoadError" role="alert">玩法配置读取失败 · {{ rpgLoadError }}</p>
        <template v-if="rpgActivities.length"
          ><h3>RPG 地图活动</h3>
          <section v-for="a in rpgActivities" :key="a.key">
            <button :aria-pressed="rpgKey === a.key" @click="showRpg(a.key)">{{ a.title }} · 演出流程</button
            ><button @click="emit('gameplay', a.location)">玩法配置与裁定来源</button
            ><button @click="emit('page', a.key)">专属页面</button>
          </section></template
        >
        <template v-if="project?.scripts.length"
          ><h3>手写活动</h3>
          <button v-for="name in project.scripts" :key="name" @click="emit('script', 'activity/' + name)">
            {{ name }} · 查看脚本
          </button></template
        >
      </aside>
      <section v-if="rpgMap" class="rpg-map" aria-label="RPG 演出流程">
        <h1>{{ rpgMap.title }}</h1>
        <RpgCueFlow :rows="rpgMap.cues" @select="i => emit('gameplay', rpgMap!.location, 'cue-' + i)" />
      </section>
      <ActivityCanvas
        v-else-if="graph"
        :graph="graph"
        :scope="scope"
        :selected="drawer === 'properties' ? selected || 'start' : ''"
        :describe="describe"
        @select="editNode"
        @enter="drill"
        @group="editGroup"
        @move="place"
      />
      <p v-else class="empty">从活动目录打开或新建一个活动。</p>
      <aside v-if="graph && !rpgMap && drawer === 'new'" aria-label="新增节点">
        <div class="drawer-head">
          <h2>新增节点</h2>
          <button @click="openPanel('')">关闭</button>
        </div>
        <button :aria-pressed="!addingGroup" @click="addingGroup = false">玩家选项</button>
        <button :aria-pressed="addingGroup" @click="addingGroup = true">子流程</button>
        <FlowGroupForm v-if="addingGroup" :graph="graph" id="" :parent="scope" @apply="applyGroup" />
        <p v-else><button :disabled="graph.choices.length >= 16" @click="appendChoice">添加玩家选项</button></p>
      </aside>
      <aside v-if="graph && drawer === 'group'" aria-label="子流程属性">
        <div class="drawer-head">
          <h2>子流程属性</h2>
          <button @click="openPanel('')">关闭</button>
        </div>
        <FlowGroupForm
          :key="groupId"
          :graph="graph"
          :id="groupId"
          :parent="graph.layout?.find(n => n.id === groupId)?.parent ?? ''"
          @apply="applyGroup"
          @dissolve="rows => applyGroup(rows, true)"
        />
      </aside>
      <aside v-if="drawer === 'references'" aria-label="引用">
        <div class="drawer-head">
          <h2>引用</h2>
          <button @click="openPanel('')">关闭</button>
        </div>
        <ActivityReferences :rows="references" :activity="graph?.key ?? ''" @source="jumpSource" @target="openTarget" />
      </aside>
      <aside v-if="graph && !rpgMap && drawer === 'properties'" aria-label="节点属性">
        <div class="drawer-head">
          <h2>{{ choice ? '选项属性' : '活动属性' }}</h2>
          <button @click="openPanel('')">关闭</button>
        </div>
        <template v-if="choice"
          ><label>选项文案<input v-model="choice.label" maxlength="80" /></label>
          <fieldset v-if="'conditions' in choice.condition">
            <legend>组合条件</legend>
            <label
              >匹配方式<select v-model="choice.condition.kind" aria-label="匹配方式">
                <option value="all">全部满足</option>
                <option value="any">满足任一项</option>
              </select></label
            >
            <button
              v-for="(leaf, i) in leaves"
              :key="i"
              :aria-pressed="!addingCondition && i === rowIndex"
              @click="activateRow(i)"
            >
              条件 {{ i + 1 }} · {{ describe(leaf) }}
            </button>
          </fieldset>
          <label>查找条件<input v-model="search" type="search" placeholder="地点、角色、物品、变量名称或 ID" /></label>
          <label
            >{{ addingCondition ? '新增条件' : '出现条件'
            }}<select
              ref="conditionControl"
              :aria-invalid="
                ownRefs.some(
                  r =>
                    !r.valid && r.field === ('conditions' in choice!.condition ? 'condition/' + rowIndex : 'condition'),
                )
              "
              :aria-label="addingCondition ? '新增条件' : '出现条件'"
              :value="conditionValue"
              @change="setCondition(($event.target as HTMLSelectElement).value)"
            >
              <option
                v-if="!addingCondition && !conditions.some(c => c.value === conditionValue)"
                :value="conditionValue"
              >
                失效的引用 · {{ conditionValue }}
              </option>
              <option v-if="addingCondition" value="" disabled>选择要添加的条件</option>
              <option v-for="r in conditions" :key="r.value" :value="r.value">
                {{ r.label }}{{ r.key ? ' · ' + r.key : '' }}
              </option>
            </select></label
          >
          <label v-if="variableDef('condition') && (activeLeaf?.kind === 'world' || activeLeaf?.kind === 'local')"
            >等于<ScalarField v-model="activeLeaf.value" :definition="variableDef('condition')!"
          /></label>
          <button v-if="addingCondition" @click="activateRow(rowIndex)">取消添加</button>
          <button v-else-if="choice.condition.kind !== 'always'" @click="beginCondition">添加条件</button>
          <button v-if="!addingCondition && 'conditions' in choice.condition" @click="removeCondition">
            移除当前条件
          </button>
          <button @click="editVariable('condition')">新建条件变量</button>
          <label
            >结果赋值（可选）<select
              ref="effectControl"
              :aria-invalid="ownRefs.some(r => !r.valid && r.field === 'effect')"
              :value="choice.effect ? choice.effect.kind + '/' + choice.effect.ref : ''"
              @change="selectVariable(($event.target as HTMLSelectElement).value, 'effect')"
            >
              <option
                v-if="choice.effect && !variableDef('effect')"
                :value="choice.effect.kind + '/' + choice.effect.ref"
              >
                失效的引用 · {{ choice.effect.ref }}
              </option>
              <option value="">不改变变量</option>
              <option v-for="v in variableRows('effect')" :key="v.kind + v.key" :value="v.kind + '/' + v.key">
                {{ v.kind === 'world' ? '世界' : '本活动' }} · {{ v.label }} · {{ v.key }}
              </option>
            </select></label
          >
          <label v-if="choice.effect && variableDef('effect')"
            >写入值<ScalarField v-model="choice.effect.value" :definition="variableDef('effect')!"
          /></label>
          <button @click="editVariable('effect')">新建结果变量</button>
          <ChoiceRuling
            ref="rulingControl"
            v-if="project"
            :choice="choice"
            :graph="graph"
            :project="project"
            @change="
              r => {
                if (choice) {
                  if (r) choice.ruling = r
                  else delete choice.ruling
                }
              }
            "
            @open="id => emit('script', 'ruling/' + id)"
          />
          <label>选择结果<textarea v-model="choice.result" maxlength="2000"></textarea></label
          ><label>玩家发言（可选）<input v-model="choice.speech" maxlength="2000" /></label>
          <label
            >接下来<select v-model="choice.next">
              <option value="end">回到日常</option>
              <option value="stay">留在本活动</option>
            </select></label
          >
          <details v-if="ownRefs.length">
            <summary>此选项的引用（{{ ownRefs.length }}）</summary>
            <div v-for="r in ownRefs" :key="r.field" :class="{ invalid: !r.valid }">
              {{ r.fieldLabel }} · {{ r.target }} <button v-if="r.valid" @click="openTarget(r)">打开定义</button
              ><button v-else @click="jumpSource(r)">修复引用</button>
            </div>
          </details>
          <div class="actions">
            <button :disabled="choiceIndex <= 0" @click="moveChoice(-1)">上移</button>
            <button :disabled="choiceIndex >= graph.choices.length - 1" @click="moveChoice(1)">下移</button>
            <button @click="removeChoice">移除选项</button>
          </div> </template
        ><template v-else
          ><label>名称<input v-model="graph.title" maxlength="80" /></label
          ><label>开场<textarea v-model="graph.opening" maxlength="500"></textarea></label>
          <button v-if="localOrigin" :disabled="!!localDraft" @click="jumpSource(localOrigin)">← 返回引用字段</button>
          <h3>本活动变量</h3>
          <div v-for="v in graph.variables" :key="v.key">
            <button @click="editVariable('definition', v)">{{ v.label }} · {{ v.key }}</button
            ><button @click="usesOfLocal(v.key)">查看引用</button>
          </div>
          <button v-for="r in localRefs" :key="[r.id, r.choice, r.field].join('/')" @click="focusLocal(r)">
            {{ r.label }}
          </button>
          <button @click="editVariable('definition')">添加活动变量</button>
        </template>
        <section v-if="localDraft" class="variable-form">
          <h3>变量定义</h3>
          <VariableFields v-model="localDraft" :locked="!!oldVariable" />
          <label
            >归属<select v-model="variableScope">
              <option v-if="variableField !== 'definition'" value="world">世界公共</option>
              <option value="shared">本活动 · 参与者共享</option>
              <option value="private">本活动 · 行动者私有</option>
              <option v-if="variableField !== 'condition'" value="internal">本活动 · 内部结算</option>
            </select></label
          >
          <button @click="keepVariable">{{ variableField === 'definition' ? '保存变量' : '创建并选用' }}</button
          ><button @click="localDraft = undefined">取消</button>
        </section>
      </aside>
      <aside v-if="!rpgMap && drawer === 'trial'" class="trial" aria-label="试玩记录">
        <div class="drawer-head">
          <h2>试玩记录</h2>
          <button @click="openPanel('')">关闭</button>
        </div>
        <button :disabled="busy" @click="run()">按当前起点试玩</button>
        <details>
          <summary>试玩起点</summary>
          <label v-for="item in trialItems" :key="item.id"
            ><input v-model="takeItems" :disabled="busy" type="checkbox" :value="item.id" />先拿起{{ item.name }}</label
          >
          <template v-for="v in trialWorld" :key="v.key">
            <label
              ><input
                type="checkbox"
                :disabled="busy"
                :checked="Object.hasOwn(startWorld, v.key)"
                @change="toggleWorldStart(v, ($event.target as HTMLInputElement).checked)"
              />指定{{ v.label }}的开局值</label
            >
            <label v-if="Object.hasOwn(startWorld, v.key)"
              >{{ v.label }}开局值<ScalarField
                v-model="startWorld[v.key]!"
                :definition="v"
                :disabled="busy"
                :aria-label="v.label + '开局值'"
            /></label>
          </template>
          <label v-for="c in project?.characters" :key="c.id"
            >{{ c.name
            }}<select
              :aria-label="c.name + '的开局场景'"
              :disabled="busy"
              :value="locations[c.id] ?? ''"
              @change="setLocation(c.id, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">包内开局</option>
              <option v-for="s in project?.scenes" :key="s.id" :value="s.id">{{ s.name }} · {{ s.id }}</option>
            </select></label
          >
        </details>
        <template v-if="preview"
          ><p>
            本次试玩 · {{ preview.graph.title }} · {{ preview.graph.opening }}
            <small :title="preview.packHash"
              >源包 {{ preview.packHash.replace(/^sha256:/, '').slice(0, 12)
              }}{{ JSON.stringify(preview.graph) !== JSON.stringify(graph) ? ' · 草稿已改动' : '' }}</small
            >
          </p>
          <div v-for="c in preview.checks" :key="c.id" class="check">
            <strong>{{ c.label }}</strong
            ><span>{{ c.available ? '可选' : '不可选' }} · {{ describe(c.condition) }}</span>
            <button :disabled="busy" @click="locate(c.id)">定位条件</button
            ><button v-if="c.available" :disabled="busy" @click="run(c.id)">从起点执行</button>
          </div>
          <p v-if="preview.settlement">
            {{ preview.settlement.label }}：{{ preview.settlement.before ?? '未显示' }} →
            {{ preview.settlement.after ?? '未显示' }}
          </p>
          <p v-for="(line, i) in preview.lines" :key="i">{{ line.text }}</p>
        </template>
        <p v-else>点击「试玩」查看正式活动提供的选项。</p>
      </aside>
    </fieldset>
  </main>
</template>
<style scoped>
.activity-editor {
  display: flex;
  flex-direction: column;
  position: relative;
  height: 100dvh;
  color: #242424;
  background: white;
  font:
    14px/1.5 'Source Sans 3',
    'Microsoft YaHei UI',
    sans-serif;
}
header,
.actions,
.breadcrumb,
.drawer-head,
.check {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
header {
  min-height: 54px;
  box-sizing: border-box;
  padding: 9px 16px;
  border-bottom: 1px solid #ccc;
  background: white;
}
.actions {
  margin-left: auto;
}
.breadcrumb b {
  font-size: 17px;
}
.breadcrumb span,
small {
  color: #666;
}
button,
input,
select,
textarea {
  font: inherit;
  color: inherit;
  background: white;
  border: 1px solid #bbb;
  border-radius: 3px;
  padding: 6px 9px;
  box-sizing: border-box;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
}
button[aria-pressed='true'],
button.primary {
  color: white;
  background: #242424;
  border-color: #242424;
}
.workspace {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  border: 0;
  padding: 0;
  margin: 0;
}
.empty,
.rpg-map {
  padding: 24px;
}
aside {
  position: absolute;
  z-index: 2;
  inset: 0 0 0 auto;
  width: min(390px, 100%);
  box-sizing: border-box;
  background: white;
  border-left: 1px solid #c7c7c7;
  padding: 12px 18px;
  overflow: auto;
  box-shadow: -4px 0 15px #0001;
}
aside label {
  display: block;
  margin: 9px 0;
}
aside :is(input:not([type='checkbox']), select, textarea) {
  display: block;
  width: 100%;
  margin-top: 4px;
}
fieldset:not(.workspace) {
  min-width: 0;
}
aside textarea {
  min-height: 70px;
}
aside details,
aside .actions {
  margin: 14px 0;
}
aside[aria-label='活动目录'] > button {
  display: block;
  margin: 7px 0;
}
.drawer-head {
  justify-content: space-between;
  position: sticky;
  top: -12px;
  background: white;
  z-index: 1;
  padding: 6px 0 10px;
  border-bottom: 1px solid #ddd;
  margin-bottom: 12px;
}
.drawer-head h2 {
  font-size: 17px;
  margin: 0;
}
.check {
  padding: 9px 0;
  border-top: 1px solid #ddd;
}
.notice {
  padding: 5px 16px;
  margin: 0;
  background: #f5f5f5;
}
.notice[role='alert'],
.invalid {
  color: #a32222;
}
[aria-invalid='true'] {
  border-color: #ac2929;
  color: #a32222;
}
@media (max-width: 700px) {
  header {
    gap: 4px;
    padding: 6px;
  }
  .actions {
    margin-left: 0;
  }
  .actions small {
    display: none;
  }
  button {
    padding: 4px 7px;
  }
  aside {
    width: min(350px, 93vw);
  }
}
</style>
