import type { CompiledWorldPackV5 } from './contracts.ts'

/** The pack facts a content generator reads; the same shape as the plugin SDK's ContentPackFacts. */
export interface PackContentFacts {
  characterIds: string[]
  locationIds: string[]
  entityIds: string[]
  entityLocations: Record<string, string | null>
  playerId?: string
  names: Record<string, string>
}

/** The part of a plugin's content generator that finding and parsing its config file needs. */
export interface PackContentGenerator<Generated = unknown> {
  readonly id: string
  readonly version: string
  readonly configFile: string
  generate(config: unknown, pack: PackContentFacts): Generated
}

export function packContentFacts(pack: CompiledWorldPackV5): PackContentFacts {
  const { characters, locations, entities, playerSlots } = pack.content
  const player = playerSlots[0]?.characterId
  return {
    characterIds: characters.map(character => character.characterId),
    locationIds: locations.map(location => location.locationId),
    entityIds: entities.map(entity => entity.entityId),
    entityLocations: Object.fromEntries(entities.map(entity => [entity.entityId, entity.locationId])),
    ...(player === undefined ? {} : { playerId: player }),
    names: Object.fromEntries([
      ...characters.map(character => [character.characterId, character.displayName]),
      ...locations.map(location => [location.locationId, location.name]),
    ]),
  }
}

/**
 * Generate only explicitly selected content. Static validation is a separate pure pass;
 * ordinary JSON assets cannot opt the world into executable gameplay.
 */
export function generatePackContent<G extends PackContentGenerator>(
  pack: CompiledWorldPackV5,
  generators: readonly G[],
  read: (file: string) => string,
): { generator: G; config: unknown; generated: ReturnType<G['generate']> }[] {
  const results: { generator: G; config: unknown; generated: ReturnType<G['generate']> }[] = []
  const ids = new Set<string>()
  for (const generator of generators) {
    if (ids.has(generator.id)) throw new TypeError('Duplicate content plugin: ' + generator.id)
    ids.add(generator.id)
    const selection = pack.plugins?.[generator.id]
    if (!selection) continue
    const file = selection.config ?? generator.configFile
    if (!pack.assets.some(asset => asset.path === file)) throw new TypeError(generator.id + ': missing config ' + file)
    const config: unknown = JSON.parse(read(file))
    const generated = generator.generate(config, packContentFacts(pack)) as ReturnType<G['generate']>
    results.push({ generator, config, generated })
  }
  return results
}
