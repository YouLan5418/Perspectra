import type { AutonomySource, CommunicationSource } from '@perspectra/sdk'
import type { CompiledWorldPackV5 } from '@perspectra/world-pack'
import { packJsonAsset } from './pack-json-asset.ts'
export function loadCommunicationSource(root: string, pack: CompiledWorldPackV5): CommunicationSource | undefined {
  if (!pack.plugins?.['official-communication']) return undefined
  const config = packJsonAsset(root, pack, pack.plugins['official-communication'].config ?? 'communication.json')
  return config === undefined ? undefined : { config }
}
export function loadAutonomySource(root: string, pack: CompiledWorldPackV5): AutonomySource | undefined {
  if (!pack.plugins?.['official-autonomy']) return undefined
  const config = packJsonAsset(root, pack, pack.plugins['official-autonomy'].config ?? 'autonomy.json')
  if (config === undefined) return undefined
  const characterIds = pack.content.characters.map(character => String(character.characterId))
  return {
    config,
    characterIds,
    locationIds: pack.content.locations.map(location => location.locationId),
    targetIds: [...characterIds, ...pack.content.entities.map(entity => String(entity.entityId))],
    definitionIds: pack.interactions.definitions.map(definition => definition.ref.id),
  }
}
