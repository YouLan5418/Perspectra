import { GameplayScript } from '@perspectra/providers/activities'
import { validatePluginConfig, packContentFacts, type CompiledWorldPackV5 } from '@perspectra/world-pack'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
// Static process composition: no Host, model channel or Python runtime.
import { officialRpgContent } from '@perspectra/plugins/rpg'
import { officialTrpgContent } from '@perspectra/plugins/trpg'
import type { PackPluginDescriptor } from '@perspectra/world-pack'

export const officialPackPlugins: readonly PackPluginDescriptor[] = [
  officialRpgContent,
  officialTrpgContent,
  { id: 'official-dice', version: '1' },
  { id: 'official-autonomy', version: '1', configFile: 'autonomy.json' },
  { id: 'official-pacing', version: '1' },
  { id: 'official-communication', version: '1', configFile: 'communication.json' },
  { id: 'basic-interactions', version: '1' },
  // Existing source scripts remain explicitly opt-in until their authors migrate.
  { id: 'pack-scripts', version: '1' },
]
export const officialPackContent = [officialRpgContent, officialTrpgContent]

/** Pure author preflight. Script functions execute in their VM; no world/provider is opened. */
export function validatePackScript(source: string, config: WorldJsonObject, pack: CompiledWorldPackV5): void {
  const script = new GameplayScript(source)
  try {
    const definition = script.definition
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
