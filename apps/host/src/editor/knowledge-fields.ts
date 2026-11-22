import { isDeepStrictEqual } from 'node:util'
import { compileWorldPackSource } from '@perspectra/world-pack'
import { configObject } from '@perspectra/world-pack/editor-config'
import {
  knowledgeTermError,
  knowledgeField,
  knowledgeSchema,
  readKnowledgeCondition,
  type KnowledgeCondition,
  type KnowledgeField,
  type KnowledgePath,
} from '@perspectra/world-pack/editor-knowledge'
import { officialPackContent, officialPackPlugins } from '../official-pack-metadata.ts'
import { loadPackContent } from '../runtime/pack-content.ts'
import { readActivityMenus } from '../runtime/activity-page-catalog.ts'
import { withDraftActivities } from './activity-pages.ts'
import { readProject } from './project.ts'
import { editorStatusOperations } from './event-options.ts'
import { knowledgeBook, saveKnowledge, type KnowledgeRow } from './knowledge.ts'
import { knowledgeEquality } from '@perspectra/world-pack/editor-fields'
import { worldRecords } from './world-records.ts'

export async function knowledgeFields(root: string) {
  const pack = await compileWorldPackSource(root, []),
    content = loadPackContent(root, pack, officialPackContent, officialPackPlugins)
  try {
    const book = knowledgeBook(root),
      project = readProject(root),
      all = worldRecords(root).records
    const status = editorStatusOperations(root, pack, content),
      menus = withDraftActivities(readActivityMenus(root, pack, content), project)
    const records = (kind: string) => all.filter(r => r.kind === kind).map(r => ({ value: r.id, label: r.name }))
    const strings = (values: readonly string[]) => values.map(value => ({ value, label: value }))
    const actors = records('character'),
      places = records('location'),
      items = records('item')
    const fields: KnowledgeField[] = [
      { path: ['characterId'], label: '当前读者', type: 'string', choices: actors },
      { path: ['locationId'], label: '读者所在地点', type: 'string', choices: places },
      { path: ['scene', 'people', null, 'characterId'], label: '在场角色', type: 'string', choices: actors },
      { path: ['stimulus', null, 'content', 'actorId'], label: '本次刺激 › 行动角色', type: 'string', choices: actors },
      {
        path: ['stimulus', null, 'content', 'eventNotice'],
        label: '本次刺激 › 收到的世界事件通知',
        type: 'string',
        choices: project.rules.events.flatMap(e =>
          [...new Set([e.observation, ...(e.sceneNotices ?? []).map(n => n.text ?? e.observation)])].map(value => ({
            value,
            label: e.id + ' › ' + value,
          })),
        ),
        openChoices: true,
      },
      {
        path: ['knownStatus', null, 'key'],
        label: '已知状态记录 › 状态键',
        type: 'string',
        choices: Array.from(
          new Map([
            ...status.statuses.map(s => [s.key, { value: s.key, label: s.label }] as const),
            ...book.candidates.variables.map(v => [v.key, { value: v.key, label: v.label }] as const),
          ]).values(),
        ),
      },
      { path: ['knownStatus', null, 'current'], label: '已知状态记录 › 仍然有效', type: 'boolean' },
      { path: ['items', 'current', null, 'entityId'], label: '当前可见物品', type: 'string', choices: items },
      { path: ['items', 'lastObserved', null, 'entityId'], label: '上次观察到的物品', type: 'string', choices: items },
      {
        path: ['activity', 'activityKey'],
        label: '正在参与的活动',
        type: 'string',
        choices: [...menus].map(([value, m]) => ({ value, label: m.title })),
      },
      {
        path: ['activity', 'game', 'phase'],
        label: '活动阶段',
        type: 'string',
        choices: strings([...new Set([...menus.values()].flatMap(m => m.phases))]),
        openChoices: true,
      },
      { path: ['activity', 'game', 'round'], label: '活动回合', type: 'number' },
      { path: ['activity', 'game', 'active'], label: '活动进行中', type: 'boolean' },
      { path: ['activity', 'game', 'turn'], label: '活动当前行动者', type: 'string', choices: actors },
      { path: ['activity', 'participants', null], label: '活动参与角色', type: 'string', choices: actors },
    ]
    for (const [section, label] of [
      ['current', '当前可见物品'],
      ['lastObserved', '上次观察到的物品'],
    ] as const) {
      fields.push(
        { path: ['items', section, null, 'holderId'], label: label + ' › 持有人', type: 'string', choices: actors },
        { path: ['items', section, null, 'locationId'], label: label + ' › 地点', type: 'string', choices: places },
      )
    }
    for (const graph of project.graphs) {
      for (const v of graph.variables ?? []) {
        if (v.scope === 'internal') continue
        fields.push({
          path: ['activity', 'game', v.scope === 'shared' ? 'public' : 'private', 'variables', v.key],
          activity: graph.key,
          label: graph.title + (v.scope === 'shared' ? ' › 共享 › ' : ' › 读者本人 › ') + v.label,
          type: v.type,
          ...(v.options ? { choices: strings(v.options) } : {}),
        })
      }
    }
    function add(path: KnowledgePath, label: string, raw: unknown, fallback?: string) {
      const schema = configObject(raw)
      const values = Array.isArray(schema.enum)
        ? schema.enum
        : Object.hasOwn(schema, 'const')
          ? [schema.const]
          : undefined
      const choices = values
        ? values.flatMap(value =>
            typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
              ? [{ value, label: String(value) }]
              : [],
          )
        : undefined
      const inferred =
        choices?.length &&
        choices.length === values?.length &&
        choices.every(c => typeof c.value === typeof choices[0]!.value)
          ? typeof choices[0]!.value
          : undefined
      const type = schema.type ?? fallback ?? inferred
      fields.push({
        path,
        label,
        type:
          type === 'integer' || type === 'number'
            ? 'number'
            : type === 'string'
              ? 'string'
              : type === 'boolean'
                ? 'boolean'
                : 'object',
        ...(choices?.length ? { choices } : {}),
      })
      for (const [key, child] of Object.entries(configObject(schema.properties)))
        add([...path, key], label + ' › ' + key, child)
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        add([...path, '*'], label + ' › 自定键', schema.additionalProperties)
      if (type === 'array' && schema.items && !Array.isArray(schema.items))
        add([...path, null], label + ' › 任一项', schema.items)
    }
    for (const s of status.statuses) {
      if (s.owner === 'public') add(['public', s.key], '已知公共状态 › ' + s.label, s.schema, s.type)
      else if (s.owner === 'character') {
        add(['self', s.key], '读者自己的状态 › ' + s.label, s.schema, s.type)
        add(['characters', '*', s.key], '读者已知的角色状态 › ' + s.label, s.schema, s.type)
      }
    }
    for (const v of book.candidates.variables)
      if (!knowledgeField(fields, ['public', v.key]))
        add(['public', v.key], '已知公共状态 › ' + v.label, { type: v.type, enum: v.options })
    const paths = book.rows.flatMap(row => readKnowledgeCondition(row.delivery?.when)?.terms.map(t => t.path) ?? [])
    return { fields, actors, paths, warning: status.warning }
  } finally {
    content?.close()
  }
}
export async function buildKnowledgeCondition(root: string, group: KnowledgeCondition) {
  const schema = knowledgeSchema(group),
    { fields, actors } = await knowledgeFields(root)
  for (const t of group.terms) {
    const error = knowledgeTermError(fields, actors, t)
    if (error) throw new TypeError(error)
  }
  return { when: schema }
}

export async function saveKnowledgeRequest(root: string, body: Record<string, unknown>) {
  const row = body.row as KnowledgeRow | undefined
  if (body.condition !== undefined) {
    if (!row?.delivery) throw new TypeError('请先启用知识投放')
    const { when } = await buildKnowledgeCondition(root, body.condition as KnowledgeCondition)
    return saveKnowledge(
      root,
      { ...body, row: { ...row, delivery: { ...row.delivery, when } } },
      knowledgeEquality(when)?.key,
    )
  }
  const when = row?.delivery?.when,
    simple = knowledgeEquality(when)
  const base = body.base as KnowledgeRow | null
  if (
    simple &&
    !isDeepStrictEqual(when, base?.delivery?.when) &&
    !knowledgeBook(root).candidates.variables.some(v => v.key === simple.key)
  ) {
    const group = readKnowledgeCondition(when)!
    await buildKnowledgeCondition(root, group)
    return saveKnowledge(root, body, simple.key)
  }
  return saveKnowledge(root, body)
}
