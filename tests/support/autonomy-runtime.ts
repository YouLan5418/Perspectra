import { AutonomyPolicy } from '@perspectra/providers/scheduler'
import type { CompiledWorldPackV5 } from '@perspectra/world-pack'
import type { AutonomySource } from '@perspectra/sdk'
import { AutonomyRuntime } from '../../apps/host/src/runtime/autonomy-runtime.ts'
import { loadAutonomySource } from '../../apps/host/src/runtime/gameplay-source.ts'
export function parseAutonomy(config: unknown, pack: CompiledWorldPackV5, playerId: string) {
  const characterIds = pack.content.characters.map(character => String(character.characterId))
  const source: AutonomySource = {
    config,
    characterIds,
    locationIds: pack.content.locations.map(location => location.locationId),
    targetIds: [...characterIds, ...pack.content.entities.map(entity => String(entity.entityId))],
    definitionIds: pack.interactions.definitions.map(definition => definition.ref.id),
  }
  return new AutonomyRuntime(AutonomyPolicy.parse(config, source, playerId), source, playerId)
}
export function loadAutonomy(root: string, pack: CompiledWorldPackV5, playerId: string) {
  const source = loadAutonomySource(root, pack)
  return source === undefined
    ? undefined
    : new AutonomyRuntime(AutonomyPolicy.parse(source.config, source, playerId), source, playerId)
}
