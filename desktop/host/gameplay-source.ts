import type { AutonomySource, CommunicationSource } from '@harness-world/plugin-sdk'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import { packJsonAsset } from './pack-json-asset.ts'
export function loadCommunicationSource(root: string, pack: CompiledWorldPackV5): CommunicationSource | undefined {
  const config = packJsonAsset(root, pack, 'communication.json')
  return config === undefined ? undefined : { config }
}
export function loadAutonomySource(root: string, pack: CompiledWorldPackV5): AutonomySource | undefined {
  const config = packJsonAsset(root, pack, 'autonomy.json')
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
