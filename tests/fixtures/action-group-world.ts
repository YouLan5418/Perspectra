import { hashWorldJson, type WorldJsonObject } from '@harness-world/contracts'
import { manifestationManifestRegistries, type CompiledWorldSpec } from '@harness-world/kernel'
import { phase8ProviderCrashWorld } from './phase8-provider-world.ts'

export function actionGroupWorld(responsive = false): CompiledWorldSpec {
  const base = phase8ProviderCrashWorld()
  const manifest = { ...base.manifest, schemaVersion: 7 as const,
    registries: manifestationManifestRegistries(),
    actionGroupPolicy: { version: 'bounded-action-group/v1' },
    manifestationPolicy: { version: 'manifestation-policy/v1', mode: 'enabled' },
    reactionPolicy: responsive ? { version: 'reaction-policy/v1', mode: 'responsive', profile: 'responsive/v1' } : { version: 'reaction-policy/v1', mode: 'disabled' },
    locations: [...base.manifest.locations, { locationId: 'location:next', name: 'Next' }],
    characters: base.manifest.characters.map(character => ({ ...character, lifecycle: 'active', controllerClass: character.characterId === 'character:player' ? 'manual' : 'scripted', pronouns: 'they', portrayal: null })),
  }
  if (responsive) Object.assign(manifest, { characters: [...manifest.characters,
    { ...manifest.characters.find(character => character.characterId === 'character:npc')!, characterId: 'character:bob', name: 'Bob' }] })
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(e => e.eventType === 'world.manifest-locked'
    ? { ...e, data: { ...e.data as WorldJsonObject, manifestHash } }
    : responsive && e.eventType === 'scene.upsert' ? { ...e, data: { sceneId: 'scene:room', value: { lifecycle: 'active', locationId: 'location:room', participantIds: ['character:player', 'character:npc', 'character:bob'] } } } : e)
  if (responsive) genesisEvents.push(
    { eventType: 'character.created', eventVersion: 1, data: { ...manifest.characters.at(-1)!, lifecycleState: 'active' } },
  )
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

export const groupOutput = {
  schemaVersion: 4, decision: 'act', actions: [
    { actionId: 'z:move', actorId: 'character:npc', actionType: 'move', actionVersion: 1,
      parameters: { locationId: 'location:next' }, manifestation: { independent: ['frown'], onSuccess: ['slow_walk'] } },
    { actionId: 'a:speak', actorId: 'character:npc', actionType: 'speak', actionVersion: 1,
      parameters: { text: 'group durable response' }, manifestation: { independent: [], onSuccess: ['quiet_voice'] } },
  ],
} as const
