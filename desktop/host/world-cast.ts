import type { CharacterId } from '@harness-world/contracts'
import type { CompiledWorldManifest } from '@harness-world/kernel'
import type { WorldCast } from '@harness-world/plugin-sdk'
/** The same public cast descriptor for live worlds and explicit creator/share inspection. */
export function createWorldCast(
  manifest: CompiledWorldManifest,
  playerId: string,
  characterIds: readonly CharacterId[],
): WorldCast {
  const names = new Map(manifest.characters.map(character => [String(character.characterId), character.name]))
  return {
    playerId,
    playerName: names.get(playerId) ?? playerId,
    characterIds: [...characterIds],
    characterNames: names,
    entityIds: manifest.entities.map(entity => String(entity.entityId)),
    locationNames: new Map(manifest.locations.map(location => [String(location.locationId), location.name])),
  }
}
