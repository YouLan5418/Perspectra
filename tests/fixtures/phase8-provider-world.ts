import {
  hashWorldJson,
  PHASE8_REGISTRY_LOCKS,
  PHASE8_VOCABULARY_LOCKS,
  type WorldJsonObject,
} from '@harness-world/contracts'
import {
  phase8ManifestRegistries,
  WorldSpecCompiler,
  type CompiledWorldSpec,
} from '@harness-world/kernel'

/** Minimal Manifest V4 fixture shared by hard-crash parent and child processes. */
export function phase8ProviderCrashWorld(): CompiledWorldSpec {
  const base = new WorldSpecCompiler().compile({
    schemaVersion: 2,
    address: { tenantId: 'tenant:p8-crash', worldId: 'world:p8-crash', branchId: 'branch:main' },
    metadata: { title: 'Provider crash fixture', description: '' },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 4,
    runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
    rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
    locations: [{ locationId: 'location:room', name: 'Room' }],
    entities: [],
    characters: [
      { characterId: 'character:player', name: 'Player', locationId: 'location:room' },
      { characterId: 'character:npc', name: 'NPC', locationId: 'location:room' },
    ],
    scenes: [{ sceneId: 'scene:room', participantIds: ['character:player', 'character:npc'] }],
    goals: [], claims: [], observations: [],
    playerBindings: [{
      principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player',
    }],
    plugins: [],
  })
  const manifest = {
    ...base.manifest,
    schemaVersion: 4 as const,
    registries: phase8ManifestRegistries(),
    plugins: [
      { pluginId: 'builtin:agent-context', version: '2.0.0' },
      { pluginId: 'builtin:scene-decision', version: '2.0.0' },
    ],
    contentPack: {
      schemaVersion: 2 as const,
      packId: 'pack:p8-crash', packVersion: '1.0.0',
      packHash: hashWorldJson('pack:p8-crash', null),
      compiler: {
        id: 'test-compiler', version: '1.0.0', contractVersion: 'worldpack/v2',
        canonicalJsonVersion: 'world-json/v1', limitsProfile: 'worldpack-limits/v2',
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
      initialFacts: [], memory: [], documents: [], markdown: [],
    },
  }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { ...(event.data as WorldJsonObject), manifestHash } }
    : event.eventType === 'scene.upsert'
    ? {
        ...event,
        data: {
          sceneId: 'scene:room',
          value: {
            lifecycle: 'active', locationId: 'location:room',
            participantIds: ['character:player', 'character:npc'],
          },
        },
      }
    : event)
  return {
    manifest,
    manifestHash,
    genesisEvents,
    genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
  }
}
