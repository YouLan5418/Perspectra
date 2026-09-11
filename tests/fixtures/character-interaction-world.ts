import { hashWorldJson } from '@harness-world/contracts'
import { characterInteractionManifestRegistries, parseInteractionCatalog } from '@harness-world/kernel'
import { interactionWorld } from './interaction-world.ts'

export function characterInteractionWorld(responsive = false) {
  const base = interactionWorld(true)
  const interactionCatalog = parseInteractionCatalog({
    version: 'interaction-catalog/v2',
    definitions: [{ interactionId: 'core:hold-hand', label: '牵手', targetKind: 'character', operation: 'hold_hand',
      initiationPolicy: { manualPlayer: 'commit_then_react', autonomousCharacter: 'forbidden' } }],
    bindings: [{ targetId: 'character:npc', interactionIds: ['core:hold-hand'] }],
  }, { entityIds: base.manifest.entities.map(value => value.entityId),
    characterIds: base.manifest.characters.map(value => value.characterId), manualCharacterIds: ['character:player'] })
  const manifest = { ...base.manifest, schemaVersion: 9 as const, interactionCatalog,
    playerInputPolicy: { version: 'legacy-speech/v1' }, reactionPolicy: responsive
      ? { version: 'reaction-policy/v1', mode: 'responsive', profile: 'responsive/v1' }
      : { version: 'reaction-policy/v1', mode: 'disabled' },
    registries: characterInteractionManifestRegistries() }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { manifestHash, genesisPlanHash: manifest.genesisPlanHash } } : event)
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}
