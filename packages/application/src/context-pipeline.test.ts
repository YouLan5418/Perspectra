import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PHASE8_REGISTRY_LOCKS,
  PHASE8_VOCABULARY_LOCKS,
  brandId,
  hashWorldJson,
  type AgentProvider,
  type ProposalContext,
} from '@harness-world/contracts'
import { WorldBootstrap, WorldSpecCompiler, createCoreRulebookRegistry, type CompiledWorldSpec } from '@harness-world/kernel'
import { CognitiveMemoryService } from '@harness-world/memory'
import { CharacterRuntimeAvailabilityService, WorldStore } from '@harness-world/store-sqlite'
import { Phase8ContextPipeline } from './context-pipeline.ts'
import type { RoundParticipant } from './round-coordinator.ts'
import { SceneDecisionService } from './scene-decision.ts'

function paths() {
  const root = mkdtempSync(join(tmpdir(), 'phase8-context-pipeline-'))
  return {
    world: join(root, 'world.sqlite'), memory: join(root, 'memory.sqlite'), context: join(root, 'context.sqlite'),
  }
}

function compiled(): CompiledWorldSpec {
  const base = new WorldSpecCompiler().compile({
    schemaVersion: 2,
    address: { tenantId: 'tenant:pipeline', worldId: 'world:pipeline', branchId: 'branch:main' },
    metadata: { title: 'Rain Road', description: 'Two travelers wait in rain.' },
    timeMode: 'TURN_DRIVEN', roundQueueLimit: 8,
    runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
    rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
    locations: [{ locationId: 'location:road', name: 'Road' }], entities: [],
    characters: [
      { characterId: 'character:player', name: 'Player', locationId: 'location:road' },
      { characterId: 'character:alice', name: 'Alice', locationId: 'location:road' },
    ],
    scenes: [{ sceneId: 'scene:road', participantIds: ['character:player', 'character:alice'] }],
    goals: [], claims: [], observations: [{
      observationId: 'observation:alice:rain', observerId: 'character:alice', value: { content: 'Rain is heavy' },
    }],
    playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
    plugins: [
      { pluginId: 'builtin:scene-decision', version: '2.0.0' },
      { pluginId: 'builtin:agent-context', version: '2.0.0' },
    ],
  })
  const contentPack = {
    schemaVersion: 2 as const, packId: 'pack:pipeline', packVersion: '2.0.0',
    packHash: hashWorldJson('pack', { id: 'pipeline' }),
    compiler: {
      id: 'compiler:world-pack', version: '0.2.0', contractVersion: 'worldpack-compiler/v2',
      canonicalJsonVersion: 'world-json/v1' as const, limitsProfile: 'worldpack-limits/v2',
    },
    pluginLocks: [], vocabularyLocks: PHASE8_VOCABULARY_LOCKS, registryLocks: PHASE8_REGISTRY_LOCKS,
    runtimeCapabilities: {
      publicSpeechObservationVersion: 1 as const, cognitionProjectionVersion: 1 as const,
      sceneDecisionVersion: 2 as const, cognitiveMemoryVersion: 2 as const, agentContextVersion: 2 as const,
    },
    presentation: {}, initialFacts: [],
    memory: [{ characterId: 'character:alice', profile: 'compact', attentionTopics: ['rain'] }],
    documents: [], markdown: [],
  }
  const characters = base.manifest.characters.map(character => ({
    ...character, controllerClass: character.characterId === 'character:player' ? 'manual' as const : 'scripted' as const,
    pronouns: 'they', lifecycle: 'active' as const, portrayal: character.characterId === 'character:alice'
      ? { summary: 'A careful traveler' }
      : null,
  }))
  const scenes = base.manifest.scenes.map(scene => ({
    ...scene, lifecycle: 'active' as const, locationId: 'location:road',
  }))
  const manifest = { ...base.manifest, schemaVersion: 4 as const, characters, scenes, contentPack }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(event => {
    if (event.eventType === 'world.manifest-locked') {
      return { ...event, data: { manifestHash, genesisPlanHash: manifest.genesisPlanHash } }
    }
    if (event.eventType !== 'scene.upsert') return event
    const data = event.data as { readonly sceneId: string; readonly value: { readonly participantIds: readonly string[] } }
    return {
      ...event,
      data: { sceneId: data.sceneId, value: { ...data.value, lifecycle: 'active', locationId: 'location:road' } },
    }
  })
  return {
    manifest, manifestHash, genesisEvents,
    genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
  }
}

function participant(role: 'agent' | 'director' = 'agent'): RoundParticipant {
  const provider: AgentProvider = { propose: async () => ({ participantId: `${role}:alice`, actions: [] }) }
  return {
    participantId: `${role}:alice`, role, actorId: brandId('character:alice', 'CharacterId'),
    allowedActionTypes: role === 'agent' ? ['speak', 'move'] : ['take_initiative'],
    priority: 1, estimatedTokens: 100, timeoutMs: 1000, provider,
  }
}

function proposal(spec: CompiledWorldSpec): ProposalContext {
  const playerAction = {
    actionId: 'action:player', actorId: brandId('character:player', 'CharacterId'),
    actionType: 'speak', actionVersion: 1, parameters: { text: 'Will the rain stop?' },
  }
  return {
    address: spec.manifest.address, roundId: brandId('round:pipeline', 'InteractionRoundId'),
    tick: 1, playerAction, candidateHash: hashWorldJson('candidate', playerAction),
  }
}

function fixture() {
  const storage = paths()
  const spec = compiled()
  const store = new WorldStore(storage.world)
  new WorldBootstrap(store).activate(spec)
  const availability = new CharacterRuntimeAvailabilityService(storage.world)
  availability.initialize(spec.manifest.address, spec.manifest.characters.map(character => ({
    characterId: character.characterId, state: 'ready' as const,
  })))
  const memory = new CognitiveMemoryService(storage.memory, store, undefined, 2)
  const registry = createCoreRulebookRegistry()
  const rulebook = registry.resolve('builtin:speak-move', 2, 'pipeline-test', spec.manifest.address)
  const options = {
    path: storage.context, store, memory, availability, manifest: spec.manifest,
    manifestHash: spec.manifestHash, rulebook,
  }
  return { storage, spec, store, availability, memory, rulebook, options }
}

describe('Phase8ContextPipeline', () => {
  it('prepares a character through Memory, Checkpoint, Renderer and durable Receipt, then rebuilds identically', () => {
    const value = fixture()
    const pipeline = new Phase8ContextPipeline(value.options)
    const context = proposal(value.spec)
    const history = value.store.readEvents(value.spec.manifest.address)
    const decision = new SceneDecisionService(value.store, value.availability, 2)
      .decide(value.spec.manifest.address, context.playerAction.actorId, value.store.head(value.spec.manifest.address).headSeq)
    const first = pipeline.prepare(participant(), context, history, decision, decision.asOfSeq, () => undefined)
    expect(first.providerContext).toMatchObject({
      agentContextVersion: 2, participantId: 'agent:alice', contextReceiptId: first.receipt.receiptId,
      contextHash: first.receipt.contextHash, providerRequestHash: first.receipt.providerRequestHash,
    })
    expect(JSON.stringify(first.providerContext)).not.toContain('memorySourceRefs')
    expect(first.providerContext.exactProviderRequest.messages[0]?.role).toBe('system')
    expect(first.recallResultHash).toMatch(/^sha256:/)
    expect(pipeline.prepare(participant(), context, history, decision, decision.asOfSeq, () => undefined)).toEqual(first)
    pipeline.close()

    const reopened = new Phase8ContextPipeline(value.options)
    expect(reopened.prepare(participant(), context, history, decision, decision.asOfSeq, () => undefined)).toEqual(first)
    reopened.close()
    value.memory.close()
    value.availability.close()
    value.store.close()
  })

  it('prepares a least-privilege Director request without Character Memory', () => {
    const value = fixture()
    const pipeline = new Phase8ContextPipeline(value.options)
    const context = proposal(value.spec)
    const history = value.store.readEvents(value.spec.manifest.address)
    const decision = new SceneDecisionService(value.store, value.availability, 2)
      .decide(value.spec.manifest.address, context.playerAction.actorId, value.store.head(value.spec.manifest.address).headSeq)
    const prepared = pipeline.prepare(participant('director'), context, history, decision, decision.asOfSeq, () => undefined)
    expect(prepared.receipt.participantKind).toBe('director')
    expect(prepared.receipt.subjectCharacterId).toBeNull()
    expect(prepared.memorySourceRefs).toEqual([])
    expect(JSON.stringify(prepared.providerContext.exactProviderRequest)).not.toMatch(/rawMemory|latentGuidance/)
    pipeline.close()
    value.memory.close()
    value.availability.close()
    value.store.close()
  })

  it('rejects incompatible runtime versions and malformed Scene inputs', () => {
    const value = fixture()
    const legacyMemory = new CognitiveMemoryService(join(value.storage.context, '..', 'legacy-memory.sqlite'), value.store)
    expect(() => new Phase8ContextPipeline({ ...value.options, memory: legacyMemory })).toThrow('requires')
    legacyMemory.close()
    expect(() => new Phase8ContextPipeline({
      ...value.options, manifest: { ...value.spec.manifest, schemaVersion: 3 },
    })).toThrow('requires')
    const pipeline = new Phase8ContextPipeline(value.options)
    const partialScenes = [
      { sceneId: null, observerIds: [], schedulableCharacterIds: [], visibleResultCharacterIds: [], asOfSeq: 0 },
      { schemaVersion: 'scene-decision/v2' as const, sceneId: null, observerIds: [], schedulableCharacterIds: [], visibleResultCharacterIds: [], asOfSeq: 0 },
      { schemaVersion: 'scene-decision/v2' as const, sceneId: null, memberIds: [], observerIds: [], schedulableCharacterIds: [], visibleResultCharacterIds: [], asOfSeq: 0 },
      { schemaVersion: 'scene-decision/v2' as const, sceneId: null, memberIds: [], observerIds: [], schedulableCharacterIds: [], visibleResultCharacterIds: [], directorEligible: false, asOfSeq: 0 },
    ]
    for (const scene of partialScenes) {
      expect(() => pipeline.prepare(
        participant(), proposal(value.spec), value.store.readEvents(value.spec.manifest.address),
        scene, 0, () => undefined,
      )).toThrow('Scene Decision v2')
    }
    pipeline.close()
    value.memory.close()
    value.availability.close()
    value.store.close()
  })

  it('fails closed when Memory v2 omits either Recall component', () => {
    const value = fixture()
    const pipeline = new Phase8ContextPipeline(value.options)
    const context = proposal(value.spec)
    const history = value.store.readEvents(value.spec.manifest.address)
    const decision = new SceneDecisionService(value.store, value.availability, 2)
      .decide(value.spec.manifest.address, context.playerAction.actorId, value.store.head(value.spec.manifest.address).headSeq)
    const spy = vi.spyOn(value.memory, 'prepare')
    spy.mockReturnValueOnce({ recallPlan: undefined, recall: undefined } as never)
    expect(() => pipeline.prepare(participant(), context, history, decision, decision.asOfSeq, () => undefined))
      .toThrow('did not produce')
    spy.mockReturnValueOnce({ recallPlan: { schemaVersion: 'recall-query-plan/v1' }, recall: undefined } as never)
    expect(() => pipeline.prepare(participant(), context, history, decision, decision.asOfSeq, () => undefined))
      .toThrow('did not produce')
    pipeline.close()
    value.memory.close()
    value.availability.close()
    value.store.close()
  })

  it('rejects Director targets when no durable Scene source exists', () => {
    const value = fixture()
    const pipeline = new Phase8ContextPipeline(value.options)
    const context = proposal(value.spec)
    const head = value.store.head(value.spec.manifest.address).headSeq
    const semantic = {
      schemaVersion: 'scene-decision/v2' as const, sceneId: 'scene:road',
      memberIds: [brandId('character:alice', 'CharacterId')],
      observerIds: [brandId('character:alice', 'CharacterId')], schedulableCharacterIds: [],
      visibleResultCharacterIds: [brandId('character:alice', 'CharacterId')], directorEligible: true, asOfSeq: head,
    }
    const decision = { ...semantic, decisionHash: hashWorldJson('scene-decision/v2', semantic) }
    const unrelated = value.store.readEvents(value.spec.manifest.address)
      .filter(event => event.eventType === 'world.created')
    expect(() => pipeline.prepare(participant('director'), context, unrelated, decision, head, () => undefined))
      .toThrow('durable Scene source')
    pipeline.close()
    value.memory.close()
    value.availability.close()
    value.store.close()
  })

  it('selects every logical Profile branch and uses an explicit Host model without trusting availability defaults', () => {
    const value = fixture()
    const context = proposal(value.spec)
    const history = value.store.readEvents(value.spec.manifest.address)
    const decision = new SceneDecisionService(value.store, value.availability, 2)
      .decide(value.spec.manifest.address, context.playerAction.actorId, value.store.head(value.spec.manifest.address).headSeq)
    const contentPack = value.spec.manifest.contentPack!
    const manifests = [
      { ...value.spec.manifest, contentPack: undefined },
      { ...value.spec.manifest, contentPack: { ...contentPack, memory: [null, [], 'bad', { characterId: 'character:other', profile: 'deep' }, { characterId: 'character:alice', profile: 'standard' }] } },
      { ...value.spec.manifest, contentPack: { ...contentPack, memory: [{ characterId: 'character:alice', profile: 'deep' }] } },
      { ...value.spec.manifest, contentPack: { ...contentPack, memory: [{ characterId: 'character:alice', profile: 'invalid' }] } },
    ] as const
    const expected = ['standard', 'standard', 'deep', 'standard']
    for (const [index, manifest] of manifests.entries()) {
      const contextPath = join(value.storage.context, '..', `profile-${index}.sqlite`)
      const pipeline = new Phase8ContextPipeline({
        ...value.options, path: contextPath,
        manifest: manifest as typeof value.spec.manifest,
        availability: index === 3 ? { get: () => undefined } as never : value.availability,
        ...(index !== 2 ? {} : {
          modelProfile: {
            providerId: 'explicit-scripted', modelId: 'explicit-v1', maximumInputBytes: 192 * 1024,
            contextWindowBytes: 256 * 1024, outputReserveBytes: 16 * 1024, safetyReserveBytes: 16 * 1024,
            minimumToolOutputBytes: 1024, sampling: { temperaturePermille: 0 },
            providerUserPartitionValue: 'overridden-by-policy',
          },
        }),
      })
      const prepared = pipeline.prepare(
        participant(), { ...context, roundId: brandId(`round:profile:${index}`, 'InteractionRoundId') },
        history, decision, decision.asOfSeq, () => undefined,
      )
      expect(prepared.receipt.contextProfileId).toBe(expected[index])
      pipeline.close()
    }
    value.memory.close()
    value.availability.close()
    value.store.close()
  })
})
