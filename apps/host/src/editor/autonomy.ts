import { realpathSync } from 'node:fs'
import { compileWorldPackSource } from '@perspectra/world-pack'
import { ACTIVITY_MANAGEMENT_OPERATIONS, MESSAGE_DEFINITION_ID, activityOperationId } from '@perspectra/sdk/contracts'
import { configCandidates, configObject, type ConfigField } from '@perspectra/world-pack/editor-config'
import { AutonomyPolicy, officialPackContent, officialPackPlugins } from '../official-pack-metadata.ts'
import { loadPackContent } from '../runtime/pack-content.ts'
import { readActivityMenus } from '../runtime/activity-page-catalog.ts'
import { editorStatusOperations } from './event-options.ts'
import { pluginBook, saveModeSource } from './mode-source.ts'
import { readProject } from './project.ts'
import { withDraftActivities } from './activity-pages.ts'
const descriptor = officialPackPlugins.find(p => p.id === 'official-autonomy')!
const interval: ConfigField = { type: 'integer', minimum: 1, maximum: 100 },
  text: ConfigField = { type: 'string' },
  ids: ConfigField = { type: 'array', items: text }
const trigger = (title: string, fields: Record<string, ConfigField>, required: string[]): ConfigField => ({
  title,
  type: 'object',
  properties: { ...fields, everyPlayerTurns: interval },
  required,
  additionalProperties: false,
})
const schema: ConfigField = {
  type: 'object',
  required: ['characters'],
  properties: {
    characters: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['characterId', 'triggers', 'everyPlayerTurns', 'opportunities', 'locationIds', 'interactions'],
        properties: {
          characterId: text,
          triggers: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: {
              oneOf: [
                trigger('说话', { actionType: { const: 'speak' } }, ['actionType']),
                trigger('移动', { actionType: { const: 'move' } }, ['actionType']),
                trigger('交互', { actionType: { const: 'interact' }, definitionId: text }, ['actionType']),
                trigger('活动操作', { activityKey: text, operation: text }, ['activityKey', 'operation']),
              ],
            },
          },
          everyPlayerTurns: interval,
          opportunities: interval,
          interactions: ids,
          locationIds: { ...ids, minItems: 1 },
          targetIds: ids,
        },
      },
    },
  },
}
export async function autonomyBook(source: string) {
  const root = realpathSync(source),
    book = pluginBook(root, descriptor),
    pack = await compileWorldPackSource(root, [])
  // Gather the other plugins' menus even when the autonomy configuration itself needs repair.
  const content = loadPackContent(root, pack, officialPackContent, [
    { id: descriptor.id, version: descriptor.version, configFile: descriptor.configFile! },
  ])
  try {
    const menus = withDraftActivities(readActivityMenus(root, pack, content), readProject(root)),
      operations = new Map<string, string>()
    const activities = [...menus].map(([id, menu]) => ({
      id,
      name: menu.title,
      operations: menu.operations
        .filter(o => o.id.startsWith('activity:') && !ACTIVITY_MANAGEMENT_OPERATIONS.has(o.id.slice(9)))
        .map(o => ({ id: o.id.slice(9), name: o.label })),
    }))
    for (const d of pack.interactions.definitions) operations.set(d.ref.id, d.ref.id)
    for (const d of content?.gameplay ?? [])
      for (const op of d.operations) if (!op.activity) operations.set(op.id, op.ui?.label ?? op.id)
    if (pack.plugins?.['official-communication']) operations.set(MESSAGE_DEFINITION_ID, '发送消息')
    for (const a of activities) for (const op of a.operations) operations.set(activityOperationId(op.id), op.name)
    const { operations: status, warning } = editorStatusOperations(root, pack, content)
    for (const op of status) operations.set('status:' + op.id, op.label)
    return {
      ...book,
      schema,
      activityMenus: activities,
      operations: [...operations].map(([id, name]) => ({ id, name })),
      warning,
    }
  } finally {
    content?.close()
  }
}
export async function autonomyCandidates(source: string, body: Record<string, unknown>) {
  if (!Array.isArray(body.path) || !body.path.every(p => typeof p === 'string')) throw new TypeError('需要字段路径数组')
  const book = await autonomyBook(source)
  return {
    options:
      configCandidates(
        'autonomy',
        configObject(body.config ?? book.config),
        book,
        body.path,
        body.dictionary === true,
      ) ?? null,
  }
}
export function saveAutonomy(source: string, body: Record<string, unknown>) {
  return saveModeSource(
    source,
    body,
    descriptor,
    autonomyBook,
    () => ({ characters: [] }),
    body.operation === 'autonomy-enable',
    (config, book) => {
      const policy = AutonomyPolicy.parse(
        config,
        {
          config,
          characterIds: book.characters.map(c => c.id),
          locationIds: book.locations.map(c => c.id),
          targetIds: [...book.characters, ...book.items].map(c => c.id),
          definitionIds: book.operations.map(c => c.id),
        },
        book.player,
      )
      const original = book.config?.characters
      for (const role of policy.roles) {
        const previous = Array.isArray(original)
          ? original.map(configObject).find(r => r.characterId === role.characterId)?.triggers
          : undefined
        for (const trigger of role.triggers) {
          if (!('activityKey' in trigger)) continue
          if (
            book.activityMenus.some(
              a => a.id === trigger.activityKey && a.operations.some(o => o.id === trigger.operation),
            )
          )
            continue
          if (
            Array.isArray(previous) &&
            previous
              .map(configObject)
              .some(t => t.activityKey === trigger.activityKey && t.operation === trigger.operation)
          )
            continue
          throw new TypeError('活动中找不到操作：' + trigger.activityKey + ' › ' + trigger.operation)
        }
      }
    },
  )
}
