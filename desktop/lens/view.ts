import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LensSimulation } from './simulation.ts'

export type LensSection = 'characters' | 'knowledge' | 'places' | 'statuses' | 'items' | 'events' | 'rules' | 'presets'
export type LensSource =
  | { readonly kind: 'json'; readonly file: string; readonly pointer: string }
  | { readonly kind: 'script'; readonly file: string; readonly hook: string; readonly label?: string }
export interface LensField {
  readonly key: string
  readonly label: string
  readonly value: string | number | boolean | readonly string[]
}
export interface LensItem {
  readonly id: string
  readonly section: LensSection
  readonly title: string
  readonly parentId?: string
  readonly fields: readonly LensField[]
  readonly source: LensSource
  readonly links?: readonly string[]
}
export interface LensView {
  readonly packId: string
  readonly packVersion: string
  readonly title: string
  readonly items: readonly LensItem[]
}

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
interface Manifest {
  packId: string
  packVersion: string
  worldFile: string
  characterFiles: string[]
  locationFiles: string[]
  entityFiles: string[]
  sceneFiles: string[]
  cognitionFiles: string[]
  memoryFiles: string[]
  interactionFile: string
  assetFiles: string[]
}
const STATUS_SCRIPT = 'scripts/status.js'
const ACTORS = { player: '玩家', npc: '角色', any: '任何人' } as const
const COGNITION_KINDS: Record<string, string> = {
  observations: '初始观察',
  claims: '主张',
  goals: '目标',
  relationships: '关系',
  affects: '情绪',
  innerTensions: '内心矛盾',
  commitments: '承诺',
  openLoops: '悬念',
}

const readJson = (packPath: string, file: string): Json => JSON.parse(readFileSync(join(packPath, file), 'utf8'))
const shorten = (text: string, length: number) => (text.length > length ? text.slice(0, length) + '…' : text)
const plain = (value: unknown): string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : JSON.stringify(value)

/** Every author setting of a pack as a flat, stably identified list. Static settings come from the pack's JSON
 * files; opening values and condition results come from the simulation's real host runtime. */
export async function buildLensView(packPath: string, opening: LensSimulation): Promise<LensView> {
  const manifest = readJson(packPath, 'worldpack.source.json') as Manifest
  const items: LensItem[] = []
  const add = (item: LensItem) => items.push(item)
  const names = new Map<string, string>()
  const documents = (files: readonly string[], key: string) =>
    files.flatMap(file => (readJson(packPath, file)[key] as Json[]).map((row, index) => ({ file, row, index, key })))
  const pointer = (entry: { key: string; index: number }) => `/${entry.key}/${entry.index}`
  const json = (file: string, at: string): LensSource => ({ kind: 'json', file, pointer: at })

  const characters = documents(manifest.characterFiles, 'characters')
  const locations = documents(manifest.locationFiles, 'locations')
  const entities = documents(manifest.entityFiles, 'entities')
  const scenes = documents(manifest.sceneFiles, 'scenes')
  for (const { row } of characters) names.set(row.characterId, row.displayName)
  for (const { row } of locations) names.set(row.locationId, row.name ?? row.locationId)
  for (const { row } of entities) names.set(row.entityId, row.name ?? row.entityId)
  const name = (id: string) => names.get(id) ?? id

  const statusDefinition = opening.statusDefinition()
  const activities = opening.activityDefinitions()
  const operationLabels = new Map(statusDefinition.operations.map(op => [`status:${op.id}`, op.label]))
  const bindingLabels = new Map<string, string>()
  for (const { row } of characters)
    for (const binding of (row.interactionBindings ?? []) as Json[])
      if (!bindingLabels.has(binding.definition.id)) bindingLabels.set(binding.definition.id, binding.label)
  const interactionName = (id: string) => operationLabels.get(id) ?? bindingLabels.get(id) ?? id
  const activityTitle = new Map(activities.map(a => [a.activityKey, a.title]))
  const activityFile = (key: string) => (key === 'default' ? 'scripts/activity.js' : `scripts/activities/${key}.js`)
  const activitiesOf = (characterId: string) =>
    activities.filter(a => a.npcIds.includes(characterId) || a.participantSelection?.candidates?.includes(characterId))

  // characters (autonomy.json lists the wake-up settings per character)
  const autonomyFile = manifest.assetFiles.find(file => file === 'autonomy.json')
  const autonomy = new Map<string, Json>(
    autonomyFile ? (readJson(packPath, autonomyFile).characters as Json[]).map(row => [row.characterId, row]) : [],
  )
  const portraitFor = (characterId: string) => {
    const short = characterId.slice(characterId.indexOf(':') + 1)
    return ['png', 'webp']
      .map(ext => `frontend/portraits/${short}.${ext}`)
      .find(path => existsSync(join(packPath, path)))
  }
  const triggerText = (trigger: Json) =>
    typeof trigger.activityKey === 'string'
      ? `活动「${activityTitle.get(trigger.activityKey) ?? trigger.activityKey}」的「${
          activities
            .find(a => a.activityKey === trigger.activityKey)
            ?.operations.find(op => op.id === trigger.operation)?.label ?? trigger.operation
        }」`
      : `${trigger.actionType === 'interact' ? '交互' : trigger.actionType}${
          trigger.definitionId ? '「' + interactionName(trigger.definitionId) + '」' : ''
        }`
  for (const entry of characters) {
    const { file, row } = entry
    const wake = autonomy.get(row.characterId)
    const sceneOf = scenes.find(s => s.row.participantIds?.includes(row.characterId))
    const fields: LensField[] = [
      { key: 'name', label: '名字', value: row.displayName },
      { key: 'persona', label: '人设摘要', value: shorten(row.portrayal?.summary ?? '', 200) },
      { key: 'speakingStyle', label: '说话方式', value: shorten(row.portrayal?.speakingStyle ?? '', 200) },
    ]
    const portrait = portraitFor(row.characterId)
    if (portrait) fields.push({ key: 'portrait', label: '立绘', value: portrait })
    if (sceneOf) fields.push({ key: 'scene', label: '初始场景', value: name(sceneOf.row.locationId) })
    if (wake) {
      fields.push(
        { key: 'everyPlayerTurns', label: '唤醒频率（每几个玩家回合）', value: wake.everyPlayerTurns },
        { key: 'opportunities', label: '机会次数', value: wake.opportunities },
        { key: 'triggers', label: '叫醒事件', value: (wake.triggers as Json[]).map(triggerText) },
        { key: 'interactions', label: '可用交互', value: (wake.interactions as string[]).map(interactionName) },
        { key: 'places', label: '可去地点', value: (wake.locationIds as string[]).map(name) },
      )
    }
    const related = activitiesOf(row.characterId)
    if (related.length) fields.push({ key: 'events', label: '相关事件', value: related.map(a => a.title) })
    add({
      id: row.characterId,
      section: 'characters',
      title: row.displayName,
      fields,
      source: json(file, pointer(entry)),
      ...(related.length ? { links: related.map(a => 'event:' + a.activityKey) } : {}),
    })
  }

  // knowledge: one child per initial observation, goal, ... of each character
  for (const { file, row, index, key } of documents(manifest.cognitionFiles, 'characters')) {
    for (const [category, kind] of Object.entries(COGNITION_KINDS))
      for (const [position, entry] of ((row[category] ?? []) as Json[]).entries()) {
        const content = String(entry.content ?? entry.objective?.value ?? entry.text ?? JSON.stringify(entry))
        add({
          id: `knowledge:${row.characterId}/${entry.key}`,
          section: 'knowledge',
          title: `${kind}：${shorten(content, 24)}`,
          parentId: row.characterId,
          fields: [
            { key: 'content', label: '内容', value: content },
            { key: 'kind', label: '类型', value: entry.epistemicKind ?? kind },
            { key: 'audience', label: '受众', value: `仅 ${name(row.characterId)}` },
          ],
          source: json(file, `/${key}/${index}/${category}/${position}`),
        })
      }
  }

  // places
  for (const entry of locations) {
    const present = scenes
      .filter(s => s.row.locationId === entry.row.locationId)
      .flatMap(s => s.row.participantIds as string[])
    add({
      id: 'place:' + entry.row.locationId,
      section: 'places',
      title: name(entry.row.locationId),
      fields: [
        { key: 'name', label: '地点名', value: name(entry.row.locationId) },
        { key: 'present', label: '开场时在场者', value: present.map(name) },
      ],
      source: json(entry.file, pointer(entry)),
      ...(present.length ? { links: present } : {}),
    })
  }

  // statuses: opening values come from the simulation's real runtime
  const truth = (await opening.statusTruth()) as { public?: Json; characters?: Record<string, Json> }
  const statusIds = new Map<string, string>()
  for (const status of statusDefinition.statuses) {
    const id = 'status:' + status.key
    statusIds.set(status.key, id)
    const fields: LensField[] = [
      { key: 'key', label: '键', value: status.key },
      { key: 'label', label: '名称', value: status.label },
      { key: 'type', label: '类型', value: status.type },
      { key: 'owner', label: '归属', value: status.owner },
      { key: 'alwaysKnown', label: '人人都知道', value: status.alwaysKnown },
      { key: 'bar', label: '进状态栏', value: status.bar },
    ]
    if (status.owner === 'public')
      fields.push({ key: 'opening', label: '开场值', value: plain(truth.public?.[status.key] ?? '（无）') })
    else
      for (const { row } of characters) {
        const value = truth.characters?.[row.characterId]?.[status.key]
        if (value !== undefined)
          fields.push({
            key: 'opening:' + row.characterId,
            label: `开场值（${name(row.characterId)}）`,
            value: plain(value),
          })
      }
    add({
      id,
      section: 'statuses',
      title: status.label,
      fields,
      source: { kind: 'script', file: STATUS_SCRIPT, hook: 'definition', label: status.key },
    })
  }

  // items
  for (const entry of entities) {
    const { row } = entry
    const place = row.holderId ?? row.locationId
    const bound = statusDefinition.operations.filter(op => op.targets?.includes(row.entityId))
    add({
      id: 'item:' + row.entityId,
      section: 'items',
      title: name(row.entityId),
      fields: [
        { key: 'name', label: '名称', value: name(row.entityId) },
        { key: 'kind', label: '种类', value: row.kind ?? '' },
        { key: 'holder', label: '开场持有者或位置', value: place ? name(place) : '（无）' },
        { key: 'interactions', label: '绑定的交互', value: bound.map(op => op.label) },
      ],
      source: json(entry.file, pointer(entry)),
    })
  }

  // events: one item per activity, one child per autoStart condition
  const conditions = new Map(opening.conditionsNow().map(e => [e.activityKey, e]))
  for (const activity of activities) {
    const id = 'event:' + activity.activityKey
    const file = activityFile(activity.activityKey)
    const players = activity.participantSelection
      ? [`玩家选择 ${activity.participantSelection.min}–${activity.participantSelection.max} 位`]
      : activity.npcIds.map(name)
    add({
      id,
      section: 'events',
      title: activity.title,
      fields: [
        { key: 'title', label: '标题', value: activity.title },
        { key: 'opening', label: '开场文案', value: activity.opening ?? `${activity.title}开始。` },
        { key: 'participants', label: '参与者', value: players },
        { key: 'operations', label: '玩家操作', value: activity.operations.map(op => op.label) },
        { key: 'autoStart', label: '自动触发', value: activity.hasAutoStart },
      ],
      source: { kind: 'script', file, hook: 'definition' },
      ...(activity.npcIds.length ? { links: [...activity.npcIds] } : {}),
    })
    const used = new Map<string, number>()
    for (const [position, check] of (conditions.get(activity.activityKey)?.checks ?? []).entries()) {
      const title = check.label ?? `条件 ${position + 1}`
      const seen = (used.get(title) ?? 0) + 1
      used.set(title, seen)
      add({
        id: `${id}/when/${title}${seen > 1 ? '#' + seen : ''}`,
        section: 'events',
        title,
        parentId: id,
        fields: [{ key: 'met', label: '开场是否成立', value: check.met }],
        source: { kind: 'script', file, hook: 'autoStart', ...(check.label === null ? {} : { label: check.label }) },
      })
    }
  }

  // rules: interactions.json definitions and the status script's operations
  const interactions = manifest.interactionFile ? readJson(packPath, manifest.interactionFile) : undefined
  for (const [index, definition] of ((interactions?.definitions ?? []) as Json[]).entries()) {
    const bound = characters.filter(c =>
      (c.row.interactionBindings ?? []).some((b: Json) => b.definition.id === definition.id),
    )
    add({
      id: 'rule:' + definition.id,
      section: 'rules',
      title: interactionName(definition.id),
      fields: [
        { key: 'applies', label: '适用对象', value: bound.map(c => c.row.displayName) },
        { key: 'actors', label: 'actors', value: ACTORS.any },
        { key: 'onRoundEnd', label: '回合钩子', value: false },
      ],
      source: json(manifest.interactionFile, `/definitions/${index}`),
      ...(bound.length ? { links: bound.map(c => c.row.characterId) } : {}),
    })
  }
  for (const op of statusDefinition.operations)
    add({
      id: 'rule:status:' + op.id,
      section: 'rules',
      title: op.label,
      fields: [
        { key: 'applies', label: '适用对象', value: op.targets?.map(name) ?? ['自身'] },
        { key: 'actors', label: 'actors', value: ACTORS[op.actors] },
        { key: 'onRoundEnd', label: '回合钩子', value: statusDefinition.hasRoundHook },
      ],
      source: { kind: 'script', file: STATUS_SCRIPT, hook: 'definition', label: op.id },
    })

  // presets
  for (const file of ['model-preset.json']) {
    if (!existsSync(join(packPath, file))) continue
    const preset = readJson(packPath, file)
    add({
      id: 'preset:model',
      section: 'presets',
      title: '模型预设',
      fields: presetFields(preset),
      source: json(file, ''),
    })
  }
  if (existsSync(join(packPath, 'role-presets.json'))) {
    const roles = readJson(packPath, 'role-presets.json').characters as Record<string, Json>
    for (const [characterId, preset] of Object.entries(roles))
      add({
        id: 'preset:role/' + characterId,
        section: 'presets',
        title: `${name(characterId)} 的角色预设`,
        parentId: characterId,
        fields: presetFields(preset),
        source: json('role-presets.json', `/characters/${characterId}`),
      })
  }
  for (const { file, row, index, key } of documents(manifest.memoryFiles, 'characters'))
    add({
      id: 'preset:memory/' + row.characterId,
      section: 'presets',
      title: `${name(row.characterId)} 的记忆配置`,
      parentId: row.characterId,
      fields: [
        { key: 'profile', label: '记忆档位', value: String(row.profile) },
        { key: 'attentionTopics', label: '关注话题', value: (row.attentionTopics ?? []) as string[] },
      ],
      source: json(file, pointer({ key, index })),
    })

  const world = readJson(packPath, manifest.worldFile)
  return {
    packId: manifest.packId,
    packVersion: manifest.packVersion,
    title: String(world.title ?? manifest.packId),
    items,
  }
}

function presetFields(preset: Json): LensField[] {
  const nodes = ((preset.nodes ?? []) as Json[]).map(node => `${node.name}${node.enabled === false ? '（停用）' : ''}`)
  return [
    ...(['temperature', 'topP', 'maxOutputTokens'] as const).flatMap(key =>
      preset[key] === undefined ? [] : [{ key, label: key, value: preset[key] as number }],
    ),
    { key: 'nodes', label: '提示节点', value: nodes },
  ]
}
