import { AutonomyPolicy } from '@harness-world/official-scheduler'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import type { AutonomySource } from '@harness-world/plugin-sdk'
import { AutonomyRuntime } from '../../desktop/host/autonomy-runtime.ts'
import { loadAutonomySource } from '../../desktop/host/gameplay-source.ts'
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
