export { mapActivityKey } from '@perspectra/plugins/rpg'
export { KnowledgeSelection } from '@perspectra/providers/knowledge'
import { StatusScripts } from '@perspectra/providers/status'
import { PacingScript } from '@perspectra/plugins/pacing'
import { CommunicationRules, StatusState } from '@perspectra/core'
import type { StatusDefinition } from '@perspectra/sdk/contracts'
export function baseStatusFields(script: string) {
  const rules = new StatusScripts({ script, modules: [] })
  return (rules.definition as { statuses: StatusDefinition[] }).statuses
}
export function baseItemOperations(script: string) {
  return statusOperations({ script, modules: [] })
}
export function statusOperations(source: ConstructorParameters<typeof StatusScripts>[0]) {
  return statusAuthorFields(source).operations
}
export function statusAuthorFields(source: ConstructorParameters<typeof StatusScripts>[0]) {
  const definition = new StatusScripts(source).definition as
    | { statuses?: StatusDefinition[]; operations?: { id: string; label: string; targets?: string[] }[] }
    | undefined
  return { statuses: definition?.statuses ?? [], operations: definition?.operations ?? [] }
}
import { AutonomyPolicy } from '@perspectra/providers/scheduler'
export { AutonomyPolicy }
export function basePacingEvents(script: string) {
  const rules = new PacingScript({ script })
  return rules.worldEvents.map(id => ({ id, intensity: rules.intensity({ kind: 'event', key: id }) }))
}
import { ActivityScript, GameplayScript } from '@perspectra/providers/activities'
export function gameplayOperationList(source: string, entry: string) {
  const script = new GameplayScript(source, entry)
  try {
    return script.definition.operations.map(op => ({
      id: op.id,
      label: op.ui?.label ?? op.id,
      group: op.ui?.group,
      targetKind: op.ui?.targetKind,
      whenToUse: op.npc?.whenToUse,
      parameters: op.argumentSchema,
      activity: op.activity?.key,
    }))
  } finally {
    script.close()
  }
}
export function readActivityDefinition(entry: ConstructorParameters<typeof ActivityScript>[0]) {
  return new ActivityScript(entry).definition
}
import {
  validatePluginConfig,
  packContentFacts,
  selectedPluginConfig,
  type CompiledWorldPackV5,
} from '@perspectra/world-pack'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
// Static process composition: no Host, model channel or Python runtime.
import { generateStatusModule, officialRpgContent, parseRpgConfig } from '@perspectra/plugins/rpg'
import { officialTrpgContent } from '@perspectra/plugins/trpg'
import type { PackPluginDescriptor } from '@perspectra/world-pack'

import { scheduledNotice, encounterTables, contacts, type AuthoringFeature } from './authoring-features.ts'
import { officialWorldEvents } from '@perspectra/plugins/world-events'
export type { RpgConfig, OfficialRpgBattleView } from '@perspectra/plugins/rpg'
export {
  statKey as rpgStatKey,
  maxStatKey as rpgMaxStatKey,
  isSpentItem,
  readPartyList,
  EQUIPMENT_STATUS,
} from '@perspectra/plugins/rpg'
export type AuthoringPackPlugin = PackPluginDescriptor & { readonly authoring?: readonly AuthoringFeature[] }
export const officialPackPlugins: readonly AuthoringPackPlugin[] = [
  officialRpgContent,
  officialTrpgContent,
  { ...officialWorldEvents, authoring: [scheduledNotice] },
  { id: 'official-dice', version: '1', authoring: [encounterTables] },
  {
    id: 'official-autonomy',
    version: '1',
    configFile: 'autonomy.json',
    validateConfig(config, pack) {
      try {
        AutonomyPolicy.parse(
          config,
          {
            config: config as WorldJsonObject,
            characterIds: pack.characterIds,
            locationIds: pack.locationIds,
            targetIds: [...pack.characterIds, ...pack.entityIds],
          },
          pack.playerId ?? '',
        )
        return []
      } catch (e) {
        return [{ path: '/characters', message: (e as Error).message }]
      }
    },
  },
  { id: 'official-pacing', version: '1' },
  {
    id: 'official-communication',
    authoring: [contacts],
    version: '1',
    configFile: 'communication.json',
    configSchema: {
      type: 'object',
      required: ['medium', 'contacts'],
      additionalProperties: false,
      properties: {
        medium: { type: 'string', minLength: 1, maxLength: 40, pattern: '\\S' },
        contacts: {
          type: 'object',
          additionalProperties: { type: 'array', uniqueItems: true, items: { type: 'string' } },
        },
      },
    },
    validateConfig(config, pack) {
      try {
        new CommunicationRules(config, pack.characterIds)
        return []
      } catch (e) {
        return [{ path: '/contacts', message: (e as Error).message }]
      }
    },
  },
  // Existing source scripts remain explicitly opt-in until their authors migrate.
  { id: 'pack-scripts', version: '1' },
]
export const officialPackContent = [officialRpgContent, officialTrpgContent, officialWorldEvents]

/** Only derive the official RPG status declarations. Runtime content generators stay unopened. */
export function authoringRpgModules(pack: CompiledWorldPackV5, read: (file: string) => string) {
  if (!pack.plugins?.[officialRpgContent.id]) return []
  const file = selectedPluginConfig(pack, officialRpgContent)!
  const module = generateStatusModule(parseRpgConfig(JSON.parse(read(file)), packContentFacts(pack)))
  return [{ ...module, generator: officialRpgContent.id }]
}

export function validateStatusSource(
  source: ConstructorParameters<typeof StatusScripts>[0],
  pack: CompiledWorldPackV5,
) {
  if (!source) return
  const scripts = new StatusScripts(source)
  try {
    validateStateDefinition(scripts.definition, pack)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    const modules = scripts.moduleDefinitions.map(({ id, definition }) => ({
      id,
      count: (definition.actions as unknown[]).length,
    }))
    const sources = modules.map(({ id, count }) => `${id}（${count} 个操作）`)
    if (source.script !== undefined) {
      const operations = (scripts.definition as { operations?: unknown } | null)?.operations
      const count = Array.isArray(operations)
        ? operations.length - modules.reduce((total, m) => total + m.count, 0)
        : undefined
      sources.unshift(count === undefined ? 'scripts/status.js' : `scripts/status.js（${count} 个操作）`)
    }
    throw new TypeError(`${error.message}。状态定义来源：${sources.join('、')}`)
  }
}

function validateStateDefinition(definition: unknown, pack: CompiledWorldPackV5) {
  const facts = packContentFacts(pack)
  new StatusState(definition, facts.characterIds, pack.content.entities, facts.locationIds)
}

/** Pure author preflight. Script functions execute in their VM; no world/provider is opened. */
export function validatePackScript(source: string, config: WorldJsonObject, pack: CompiledWorldPackV5): void {
  const script = new GameplayScript(source)
  try {
    const definition = script.definition
    for (const [id, roles] of Object.entries(pack.scripts?.gameplay.responders ?? {})) {
      if (!definition.operations.some(op => op.id === id)) throw new TypeError('未知回应配置操作：' + id)
      for (const role of roles)
        if (
          !pack.content.characters.some(
            c => c.characterId === role && c.controllerClass !== 'manual' && (c.lifecycle ?? 'active') === 'active',
          ) ||
          pack.content.playerSlots.some(s => s.characterId === role)
        )
          throw new TypeError(id + ' 的回应角色必须是包内 NPC：' + role)
    }
    if (definition.states || definition.statusPolicy) {
      validateStateDefinition(
        { statuses: definition.states ?? [], operations: definition.statusPolicy?.operations ?? [] },
        pack,
      )
    }
    validatePluginConfig(
      {
        id: definition.id,
        version: definition.version,
        configSchema: definition.configSchema,
        validateConfig: raw =>
          definition.validateConfig?.({
            config: raw as WorldJsonObject,
            entities: [
              ...pack.content.characters.map(row => ({ id: row.characterId, kind: 'character' })),
              ...pack.content.locations.map(row => ({ id: row.locationId, kind: 'location' })),
              ...pack.content.entities.map(row => ({ id: row.entityId, kind: 'entity' })),
            ],
          }) ?? [],
      },
      config,
      packContentFacts(pack),
      pack.scripts?.gameplay.entry,
    )
  } finally {
    script.close()
  }
}
