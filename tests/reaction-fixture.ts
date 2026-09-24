import { PHASE8_REGISTRY_LOCKS, PHASE8_VOCABULARY_LOCKS, hashWorldJson, type WorldAddress } from '@harness-world/contracts'
import { phase8ManifestRegistries, WorldSpecCompiler, type CompiledWorldSpec } from '@harness-world/kernel'

export function v5Manifest(options: {
  readonly address?: WorldAddress
  readonly npcIds?: readonly string[]
} = {}): CompiledWorldSpec {
  const npcIds = options.npcIds ?? ['character:alice', 'character:bob']
  const base = new WorldSpecCompiler().compile({
    schemaVersion: 2,
    address: options.address ?? { tenantId: 'tenant:reaction-e2e', worldId: 'world:reaction-e2e', branchId: 'branch:main' },
    metadata: { title: 'Reaction e2e', description: '' },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 8,
    runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
    rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
    locations: [{ locationId: 'location:room', name: 'Room' }],
    entities: [],
    characters: [
      { characterId: 'character:player', name: 'Player', locationId: 'location:room' },
      ...npcIds.map(characterId => ({ characterId,
        name: characterId === 'character:alice' ? 'Alice' : characterId === 'character:bob' ? 'Bob' : characterId,
        locationId: 'location:room' })),
    ],
    scenes: [{ sceneId: 'scene:room', participantIds: ['character:player', ...npcIds] }],
    goals: [], claims: [], observations: [],
    playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
    plugins: [
      { pluginId: 'builtin:scene-decision', version: '2.0.0' },
      { pluginId: 'builtin:agent-context', version: '2.0.0' },
    ],
  })
  const characters = base.manifest.characters.map(character => ({
    ...character,
    controllerClass: character.characterId === 'character:player' ? 'manual' as const : 'scripted' as const,
    pronouns: 'they',
    lifecycle: 'active' as const,
    portrayal: null,
  }))
  const scenes = base.manifest.scenes.map(scene => ({
    ...scene,
    lifecycle: 'active' as const,
    locationId: 'location:room',
  }))
  const contentPack = {
    schemaVersion: 2 as const,
    packId: 'pack:reaction-e2e',
    packVersion: '1.0.0',
    packHash: hashWorldJson('pack:reaction-e2e', null),
    compiler: {
      id: 'test-compiler', version: '1.0.0', contractVersion: 'worldpack/v2',
      canonicalJsonVersion: 'world-json/v1' as const, limitsProfile: 'worldpack-limits/v2',
    },
    pluginLocks: [],
    vocabularyLocks: PHASE8_VOCABULARY_LOCKS,
    registryLocks: PHASE8_REGISTRY_LOCKS,
    runtimeCapabilities: {
      publicSpeechObservationVersion: 1 as const,
      cognitionProjectionVersion: 1 as const,
      sceneDecisionVersion: 2 as const,
      cognitiveMemoryVersion: 2 as const,
      agentContextVersion: 2 as const,
    },
    presentation: { schemaVersion: 'worldpack-presentation/v1', locale: 'en', style: 'plain' },
    initialFacts: [],
    memory: npcIds.map(characterId => ({ characterId, profile: 'compact', attentionTopics: [] })),
    documents: [],
    markdown: [],
  }
  const manifest = {
    ...base.manifest,
    schemaVersion: 5 as const,
    registries: phase8ManifestRegistries(),
    characters,
    scenes,
    contentPack,
    reactionPolicy: {
      version: 'reaction-policy/v1' as const,
      mode: 'responsive' as const,
      profile: 'responsive/v1' as const,
    },
  }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(event => {
    if (event.eventType === 'world.manifest-locked') {
      return { ...event, data: { ...(event.data as Record<string, unknown>), manifestHash } }
    }
    if (event.eventType !== 'scene.upsert') return event
    const data = event.data as { readonly sceneId: string; readonly value: { readonly participantIds: readonly string[] } }
    return {
      ...event,
      data: {
        sceneId: data.sceneId,
        value: { ...data.value, lifecycle: 'active', locationId: 'location:room' },
      },
    }
  })
  return {
    manifest,
    manifestHash,
    genesisEvents,
    genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
  }
}
