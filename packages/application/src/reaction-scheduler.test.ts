import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PHASE8_REGISTRY_LOCKS,
  PHASE8_VOCABULARY_LOCKS,
  brandId,
  hashWorldJson,
  failWorld,
  type CharacterCognitionView,
  type ContextReceipt,
  type FaultInjector,
  type ReactionAgentProvider,
  type ReactionCycleDraft,
  type ReactionProposalContext,
  type SubmitActionsV2,
  type WorldEventDraft,
  type WorldHash,
} from '@harness-world/contracts'
import { createContextReceipt, ProviderCallStore } from '@harness-world/agents'
import {
  WorldBootstrap,
  WorldSpecCompiler,
  createCoreRulebookRegistry,
  type CompiledWorldSpec,
} from '@harness-world/kernel'
import {
  CharacterRuntimeAvailabilityService,
  WriterLeaseService,
  WorldStore,
  type WriterLease,
} from '@harness-world/store-sqlite'
import type { PreparedPhase8ReactionParticipant } from './context-pipeline.ts'
import {
  ReactionScheduler,
  type ReactionContextPreparer,
  type ReactionParticipantBinding,
  type ReactionSchedulerOptions,
  type ReactionWriterLeasePort,
} from './reaction-scheduler.ts'
import { ReactionCycleWorker } from './reaction-worker.ts'
import { SceneDecisionService } from './scene-decision.ts'

const roots: string[] = []
const pendingCleanup = new Set<() => void>()

function storage() {
  const root = mkdtempSync(join(tmpdir(), 'hcw-reaction-scheduler-'))
  roots.push(root)
  return { world: join(root, 'world.sqlite'), context: join(root, 'context.sqlite') }
}

function compiled(): CompiledWorldSpec {
  const base = new WorldSpecCompiler().compile({
    schemaVersion: 2,
    address: { tenantId: 'tenant:reaction', worldId: 'world:reaction', branchId: 'branch:main' },
    metadata: { title: 'Reaction fixture', description: 'Three people in one room.' },
    timeMode: 'TURN_DRIVEN', roundQueueLimit: 8,
    runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
    rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
    locations: [{ locationId: 'location:room', name: 'Room' }], entities: [],
    characters: [
      { characterId: 'character:player', name: 'Player', locationId: 'location:room' },
      { characterId: 'character:alice', name: 'Alice', locationId: 'location:room' },
      { characterId: 'character:bob', name: 'Bob', locationId: 'location:room' },
    ],
    scenes: [{ sceneId: 'scene:room', participantIds: ['character:player', 'character:alice', 'character:bob'] }],
    goals: [], claims: [], observations: [],
    playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
    plugins: [
      { pluginId: 'builtin:scene-decision', version: '2.0.0' },
      { pluginId: 'builtin:agent-context', version: '2.0.0' },
    ],
  })
  const contentPack = {
    schemaVersion: 2 as const, packId: 'pack:reaction', packVersion: '2.0.0',
    packHash: hashWorldJson('pack', { id: 'reaction' }),
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
    memory: [
      { characterId: 'character:alice', profile: 'compact', attentionTopics: [] },
      { characterId: 'character:bob', profile: 'compact', attentionTopics: [] },
    ],
    documents: [], markdown: [],
  }
  const characters = base.manifest.characters.map(character => ({
    ...character,
    controllerClass: character.characterId === 'character:player' ? 'manual' as const : 'scripted' as const,
    pronouns: 'they', lifecycle: 'active' as const, portrayal: null,
  }))
  const scenes = base.manifest.scenes.map(scene => ({ ...scene, lifecycle: 'active' as const, locationId: 'location:room' }))
  const manifest = { ...base.manifest, schemaVersion: 4 as const, characters, scenes, contentPack }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(event => {
    if (event.eventType === 'world.manifest-locked') {
      return { ...event, data: { manifestHash, genesisPlanHash: manifest.genesisPlanHash } }
    }
    if (event.eventType !== 'scene.upsert') return event
    const data = event.data as { readonly sceneId: string; readonly value: { readonly participantIds: readonly string[] } }
    return { ...event, data: { sceneId: data.sceneId, value: { ...data.value, lifecycle: 'active', locationId: 'location:room' } } }
  })
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

class LeasePort implements ReactionWriterLeasePort {
  constructor(
    private readonly service: WriterLeaseService,
    private readonly address: CompiledWorldSpec['manifest']['address'],
    private lease: WriterLease,
  ) {}
  current(): WriterLease { return this.lease }
  renew(): WriterLease {
    this.lease = this.service.renew(this.address, this.lease.ownerId, this.lease.fencingToken, 10_000)
    return this.lease
  }
}

class Contexts implements ReactionContextPreparer {
  readonly seen: ReactionProposalContext[] = []
  failure?: () => never
  onReceipt?: (receipt: ContextReceipt) => void
  constructor(private readonly manifestHash: WorldHash) {}
  prepareReaction(
    binding: ReactionParticipantBinding,
    context: ReactionProposalContext,
    _history: ReturnType<WorldStore['readEvents']>,
    _decision: ReturnType<SceneDecisionService['decideFromEvents']>,
    _asOfWorldSeq: number,
    heartbeat: () => void,
  ): PreparedPhase8ReactionParticipant {
    heartbeat()
    this.failure?.()
    this.seen.push(context)
    const receipt = createContextReceipt({
      address: context.address, roundId: context.roundId, participantKind: 'character',
      participantId: binding.participantId, subjectCharacterId: binding.actorId,
      controllerId: `provider:${binding.participantId}`, controllerEpoch: 1,
      baseHeadSeq: context.stimulus.stimuli[0]!.sourceEventSeq,
      asOfWorldSeq: context.stimulus.stimuli[0]!.sourceEventSeq,
      tick: context.tick, manifestHash: this.manifestHash,
      contextProfileId: 'standard', contextProfileHash: hashWorldJson('profile', 'standard'),
      versionLocks: {
        contextSchema: 'character-controller/v2', contextReceiptSchema: 'context-receipt/v1',
        sceneDecisionSchema: 'scene-decision/v2', memorySchema: 'cognitive-memory/v2',
        checkpointSchema: 'continuity-checkpoint/v1', rendererSchema: 'structured-prompt-renderer/v1',
      },
      componentHashes: {
        characterViewHash: hashWorldJson('view', binding.actorId), sceneDecisionHash: hashWorldJson('scene', 'room'),
        checkpointHash: null, tailHash: hashWorldJson('tail', []), recallHash: hashWorldJson('recall', []),
        affordanceHash: hashWorldJson('affordance', ['speak']),
      },
      includedSourceRefs: context.stimulus.stimuli.map(value => ({
        sourceKind: 'reaction_observation', sourceId: value.observationId,
        sourceSeq: value.sourceEventSeq, sourceHash: value.sourceEventHash,
      })),
      exclusions: [], contextHash: hashWorldJson('context', context),
      providerRequestHash: hashWorldJson('provider-request', context),
    })
    this.onReceipt?.(receipt)
    return {
      providerContext: {
        ...context, agentContextVersion: 2, participantId: binding.participantId,
        contextReceiptId: receipt.receiptId, contextHash: receipt.contextHash,
        providerRequestHash: receipt.providerRequestHash,
        exactProviderRequest: { messages: [], tools: [], metadata: {} } as never,
      },
      receipt, memorySourceRefs: [], recallResultHash: hashWorldJson('recall', []),
      cognition: {} as CharacterCognitionView,
    }
  }
}

class ParallelGate {
  entered = 0
  readonly ready: Promise<void>
  #open!: () => void
  constructor() { this.ready = new Promise(resolve => { this.#open = resolve }) }
  async arrive(): Promise<void> {
    this.entered += 1
    if (this.entered === 2) this.#open()
    await this.ready
  }
}

class Provider implements ReactionAgentProvider {
  calls = 0
  constructor(
    private readonly output: SubmitActionsV2 | Error,
    private readonly gate?: ParallelGate,
    private readonly onCall?: () => void,
  ) {}
  async propose(): Promise<SubmitActionsV2> {
    this.calls += 1
    if (this.gate !== undefined) await this.gate.arrive()
    this.onCall?.()
    if (this.output instanceof Error) throw this.output
    return this.output
  }
}

function output(characterId: 'character:alice' | 'character:bob', text: string): SubmitActionsV2 {
  return {
    schemaVersion: 2, decision: 'act', actions: [{
      actionId: `action:${characterId}:wave`, actorId: characterId,
      actionType: 'speak', actionVersion: 1, parameters: { text },
    }],
  }
}

function abstain(): SubmitActionsV2 { return { schemaVersion: 2, decision: 'abstain', actions: [] } }

function binding(characterId: 'character:alice' | 'character:bob', provider: ReactionAgentProvider): ReactionParticipantBinding {
  return {
    participantId: `agent:${characterId.split(':')[1]}`, role: 'agent',
    actorId: brandId(characterId, 'CharacterId'), allowedActionTypes: ['speak'],
    priority: 0, estimatedTokens: 2, timeoutMs: 1_000, provider,
  }
}

interface FixtureOptions {
  readonly cycle?: Partial<Omit<ReactionCycleDraft, 'candidates'>>
  readonly faultInjector?: FaultInjector
}

async function fixture(
  participants: readonly ReactionParticipantBinding[],
  now = { value: 100 },
  options: FixtureOptions = {},
) {
  const paths = storage()
  const spec = compiled()
  const store = new WorldStore(paths.world, undefined, () => now.value)
  new WorldBootstrap(store).activate(spec)
  const leases = new WriterLeaseService(paths.world, () => now.value)
  const lease = leases.acquire(spec.manifest.address, 'reaction-worker:test', 10_000)
  const availability = new CharacterRuntimeAvailabilityService(paths.world)
  availability.initialize(spec.manifest.address, spec.manifest.characters.map(character => ({
    characterId: character.characterId, state: 'ready' as const,
  })))
  const head = store.head(spec.manifest.address)
  const events: WorldEventDraft[] = participants.map(participant => ({
    eventType: 'observation.upsert', eventVersion: 1,
    data: { id: `observation:root:${participant.actorId}`, value: { observerId: participant.actorId, content: 'root speech' } },
  }))
  events.push({ eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1, roundId: 'round:reaction:root' } })
  await store.commitRound({
    address: spec.manifest.address,
    transactionId: brandId('transaction:reaction:root', 'TransactionId'),
    roundId: brandId('round:reaction:root', 'InteractionRoundId'),
    expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
    events, outbox: [],
    reactionCycle: {
      policyVersion: 'reaction-policy/v1', profileId: 'responsive/v1',
      maxWaves: 3, maxNpcCalls: 8, maxCallsPerCharacter: 2,
      maxActionsPerCall: 1, allowedActionTypes: ['speak@1'],
      initialTokenBudget: 16, deadlineAtMs: 100_000,
      ...options.cycle,
      candidates: participants.map((participant, index) => ({
        characterId: participant.actorId, estimatedTokens: participant.estimatedTokens,
        stimuli: [{
          sourceEventOrdinal: index, observationOrdinal: 0,
          observationId: `observation:root:${participant.actorId}`,
          observerCharacterId: participant.actorId,
        }],
      })),
    },
    correlationId: 'reaction:root', writerFencingToken: lease.fencingToken,
  })
  const providerCalls = new ProviderCallStore(paths.context)
  const contexts = new Contexts(spec.manifestHash)
  const schedulerOptions: ReactionSchedulerOptions = {
    address: spec.manifest.address, manifest: spec.manifest, store, availability,
    sceneDecision: new SceneDecisionService(store, availability, 2),
    contextPipeline: contexts, providerCalls, rulebooks: createCoreRulebookRegistry(),
    participants, writer: new LeasePort(leases, spec.manifest.address, lease), now: () => now.value,
    ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
  }
  const scheduler = new ReactionScheduler(schedulerOptions)
  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    providerCalls.close(); availability.close(); leases.close(); store.close()
    pendingCleanup.delete(cleanup)
  }
  pendingCleanup.add(cleanup)
  return { paths, spec, store, leases, availability, providerCalls, contexts, scheduler, schedulerOptions, now, cleanup }
}

function close(value: Awaited<ReturnType<typeof fixture>>) {
  value.cleanup()
}

function proxyStore(store: WorldStore, overrides: Partial<Record<keyof WorldStore, unknown>>): WorldStore {
  return new Proxy(store, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof WorldStore]
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

afterEach(() => {
  for (const cleanup of pendingCleanup) cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ReactionScheduler', () => {
  it('drains two bounded Waves on one serial lane and carries only committed Observations forward', async () => {
    const alice = new Provider(output('character:alice', 'Alice continues.'))
    const bob = new Provider(output('character:bob', 'Bob continues.'))
    const value = await fixture([binding('character:alice', alice), binding('character:bob', bob)])
    let laneEntries = 0
    const worker = new ReactionCycleWorker({
      enqueueRound: async work => {
        laneEntries += 1
        return work()
      },
    }, value.scheduler)
    const result = await worker.drain()
    expect(laneEntries).toBe(1)
    expect(result.waves.map(wave => [wave.wave, wave.tick, wave.terminalReason])).toEqual([
      [1, 2, null],
      [2, 3, 'call_limit'],
    ])
    expect(alice.calls).toBe(2)
    expect(bob.calls).toBe(2)
    const secondWaveContexts = value.contexts.seen.filter(context => context.origin.wave === 2)
    expect(secondWaveContexts).toHaveLength(2)
    expect(secondWaveContexts.every(context => context.stimulus.stimuli.every(stimulus =>
      stimulus.sourceEventSeq > value.store.readReactionCycle(
        value.spec.manifest.address, brandId(result.cycleId!, 'ReactionCycleId'),
      )!.cycle.createdAtSeq))).toBe(true)
    expect(value.store.activeReactionCycle(value.spec.manifest.address)).toBeUndefined()
    close(value)
  })

  it('returns no work when there is no active Cycle or its status is no longer active', async () => {
    const value = await fixture([binding('character:alice', new Provider(abstain()))])
    const noCycleStore = proxyStore(value.store, { activeReactionCycle: () => undefined })
    await expect(new ReactionScheduler({ ...value.schedulerOptions, store: noCycleStore }).runCurrentWave())
      .resolves.toBeUndefined()

    const bundle = value.store.activeReactionCycle(value.spec.manifest.address)!
    const closedStore = proxyStore(value.store, {
      activeReactionCycle: () => ({ ...bundle, cycle: { ...bundle.cycle, status: 'terminal' } }),
    })
    await expect(new ReactionScheduler({ ...value.schedulerOptions, store: closedStore }).runCurrentWave())
      .resolves.toBeUndefined()
    close(value)
  })

  it('dispatches one frozen Wave in parallel and commits deterministic agent-only authority', async () => {
    const gate = new ParallelGate()
    const alice = new Provider(output('character:alice', 'Alice answers.'), gate)
    const bob = new Provider(output('character:bob', 'Bob answers.'), gate)
    const value = await fixture([binding('character:alice', alice), binding('character:bob', bob)])
    const result = await value.scheduler.runCurrentWave()
    expect(result).toMatchObject({ wave: 1, tick: 2, actionCount: 2, terminalReason: null })
    expect(gate.entered).toBe(2)
    expect(alice.calls).toBe(1)
    expect(bob.calls).toBe(1)
    expect(value.contexts.seen).toHaveLength(2)
    expect(value.contexts.seen.every(context => !('playerAction' in context))).toBe(true)
    const authority = value.store.readRoundAuthority(value.spec.manifest.address, result!.transactionId)!.authority
    expect(authority).toMatchObject({
      schemaVersion: 3, origin: { kind: 'reaction', wave: 1 },
      actions: [
        { actorId: 'character:alice', sourceRole: 'agent' },
        { actorId: 'character:bob', sourceRole: 'agent' },
      ],
    })
    expect(value.store.activeReactionCycle(value.spec.manifest.address)?.waves.at(-1)).toMatchObject({ wave: 2, status: 'frozen' })
    expect(value.store.readOutbox(value.spec.manifest.address)).toHaveLength(2)
    close(value)
  })

  it('settles all-abstain, Provider failure, and Rulebook rejection without invented world facts', async () => {
    const allAbstain = await fixture([binding('character:alice', new Provider(abstain()))])
    await expect(allAbstain.scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'all_abstained', actionCount: 0 })
    expect(allAbstain.store.readEvents(allAbstain.spec.manifest.address).some(event => event.eventType === 'character.speak')).toBe(false)
    close(allAbstain)

    const failed = await fixture([binding('character:alice', new Provider(new Error('offline')))])
    await expect(failed.scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'provider_terminal', actionCount: 0 })
    close(failed)

    const rejected = await fixture([binding('character:alice', new Provider(output('character:alice', '')))])
    await expect(rejected.scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'quiescent', actionCount: 1 })
    expect(rejected.store.readEvents(rejected.spec.manifest.address).find(event => event.eventType === 'action.resolved'))
      .toMatchObject({ data: { accepted: false } })
    close(rejected)
  })

  it('contains unavailable participants and invalid Provider output as durable terminal outcomes', async () => {
    const missing = await fixture([binding('character:alice', new Provider(abstain()))])
    const scheduler = new ReactionScheduler({
      address: missing.spec.manifest.address, manifest: missing.spec.manifest, store: missing.store,
      availability: missing.availability, sceneDecision: new SceneDecisionService(missing.store, missing.availability, 2),
      contextPipeline: missing.contexts, providerCalls: missing.providerCalls,
      rulebooks: createCoreRulebookRegistry(), participants: [],
      writer: { current: () => ({ ownerId: 'reaction-worker:test', fencingToken: 1, expiresAtMs: 10_100 }), renew: () => ({ ownerId: 'reaction-worker:test', fencingToken: 1, expiresAtMs: 10_100 }) },
      now: () => 100,
    })
    await expect(scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'quiescent' })
    close(missing)

    const invalidOutput = { schemaVersion: 2, decision: 'act', actions: [] } as SubmitActionsV2
    const invalid = await fixture([binding('character:alice', new Provider(invalidOutput))])
    await expect(invalid.scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'provider_terminal' })
    close(invalid)
  })

  it('rejects invalid Scheduler bindings before acquiring or dispatching work', async () => {
    const base = binding('character:alice', new Provider(abstain()))
    const value = await fixture([base])
    const options = value.schedulerOptions
    expect(() => new ReactionScheduler({ ...options, participants: [base, base] })).toThrow('duplicate')
    expect(() => new ReactionScheduler({
      ...options,
      participants: [{ ...base, actorId: brandId('character:missing', 'CharacterId') }],
    })).toThrow('absent from the Manifest')
    expect(() => new ReactionScheduler({ ...options, participants: [{ ...base, allowedActionTypes: [] }] })).toThrow('only speak')
    expect(() => new ReactionScheduler({ ...options, participants: [{ ...base, allowedActionTypes: ['speak', 'move'] }] })).toThrow('only speak')
    expect(() => new ReactionScheduler({ ...options, participants: [{ ...base, timeoutMs: 0 }] })).toThrow('timeoutMs')
    expect(() => new ReactionScheduler({ ...options, participants: [{ ...base, timeoutMs: 1.5 }] })).toThrow('timeoutMs')
    expect(() => new ReactionScheduler({ ...options, participants: [{ ...base, estimatedTokens: 0 }] })).toThrow('estimatedTokens')
    expect(() => new ReactionScheduler({ ...options, participants: [{ ...base, estimatedTokens: 1.5 }] })).toThrow('estimatedTokens')
    expect(() => new ReactionScheduler(({ ...options, now: undefined }) as unknown as ReactionSchedulerOptions)).not.toThrow()
    close(value)
  })

  it('fails closed for divergent Wave state, Head, claims, and durable stimuli', async () => {
    const participant = binding('character:alice', new Provider(abstain()))

    const wrongWave = await fixture([participant])
    const bundle = wrongWave.store.activeReactionCycle(wrongWave.spec.manifest.address)!
    const committedWave = { ...bundle.waves.at(-1)!, status: 'committed' as const }
    const wrongWaveStore = proxyStore(wrongWave.store, {
      activeReactionCycle: () => ({ ...bundle, waves: [...bundle.waves.slice(0, -1), committedWave] }),
    })
    await expect(new ReactionScheduler({ ...wrongWave.schedulerOptions, store: wrongWaveStore }).runCurrentWave())
      .rejects.toThrow('frozen Wave')
    close(wrongWave)

    const wrongHead = await fixture([participant])
    const realHead = wrongHead.store.head(wrongHead.spec.manifest.address)
    const wrongHeadStore = proxyStore(wrongHead.store, {
      head: () => ({ ...realHead, headSeq: realHead.headSeq + 1 }),
    })
    await expect(new ReactionScheduler({ ...wrongHead.schedulerOptions, store: wrongHeadStore }).runCurrentWave())
      .rejects.toThrow('base Head')
    close(wrongHead)

    const missingClaim = await fixture([participant])
    const missingClaimStore = proxyStore(missingClaim.store, { claimNextReactionJob: () => undefined })
    await expect(new ReactionScheduler({ ...missingClaim.schedulerOptions, store: missingClaimStore }).runCurrentWave())
      .rejects.toThrow('claim every reserved Job')
    close(missingClaim)

    const missingStimulus = await fixture([participant])
    const history = missingStimulus.store.readEvents(missingStimulus.spec.manifest.address)
      .filter(event => event.eventType !== 'observation.upsert')
    const missingStimulusStore = proxyStore(missingStimulus.store, { readEvents: () => history })
    await expect(new ReactionScheduler({ ...missingStimulus.schedulerOptions, store: missingStimulusStore }).runCurrentWave())
      .rejects.toThrow('missing or divergent')
    close(missingStimulus)

    const divergentContent = await fixture([participant])
    const divergentHistory = divergentContent.store.readEvents(divergentContent.spec.manifest.address).map(event =>
      event.eventType === 'observation.upsert' ? { ...event, data: { id: 'observation:wrong', value: {} } } : event)
    const divergentStore = proxyStore(divergentContent.store, { readEvents: () => divergentHistory })
    await expect(new ReactionScheduler({ ...divergentContent.schedulerOptions, store: divergentStore }).runCurrentWave())
      .rejects.toThrow('content is divergent')
    close(divergentContent)
  })

  it('settles lifecycle, availability, Scene, and Context preparation failures without dispatch', async () => {
    const participant = binding('character:alice', new Provider(abstain()))

    const lifecycle = await fixture([participant])
    const lifecycleHistory = [...lifecycle.store.readEvents(lifecycle.spec.manifest.address), {
      ...lifecycle.store.readEvents(lifecycle.spec.manifest.address).at(-1)!,
      eventType: 'character.lifecycle-changed', data: { characterId: participant.actorId, lifecycleState: 'dead' },
    }]
    const lifecycleStore = proxyStore(lifecycle.store, { readEvents: () => lifecycleHistory })
    await expect(new ReactionScheduler({ ...lifecycle.schedulerOptions, store: lifecycleStore }).runCurrentWave())
      .resolves.toMatchObject({ terminalReason: 'quiescent' })
    close(lifecycle)

    const unavailable = await fixture([participant])
    unavailable.availability.set(unavailable.spec.manifest.address, participant.actorId, 'offline', 'test')
    await expect(unavailable.scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'quiescent' })
    close(unavailable)

    const absentScene = await fixture([participant])
    const realScene = absentScene.schedulerOptions.sceneDecision
    const sceneDecision = {
      decideFromEvents: (...args: Parameters<SceneDecisionService['decideFromEvents']>) => ({
        ...realScene.decideFromEvents(...args), observerIds: [],
      }),
      audienceForAction: realScene.audienceForAction.bind(realScene),
    } as unknown as SceneDecisionService
    await expect(new ReactionScheduler({ ...absentScene.schedulerOptions, sceneDecision }).runCurrentWave())
      .resolves.toMatchObject({ terminalReason: 'quiescent' })
    close(absentScene)

    const contextFailure = await fixture([participant])
    contextFailure.contexts.failure = () => { throw new Error('memory lag') }
    await expect(contextFailure.scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'quiescent' })
    close(contextFailure)

    const integrity = await fixture([participant])
    integrity.contexts.failure = () => failWorld({
      errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: 'context divergent',
      retryable: false, correlationId: 'reaction:test:integrity',
    })
    await expect(integrity.scheduler.runCurrentWave()).rejects.toThrow('context divergent')
    close(integrity)
  })

  it('settles a Wave stopped before dispatch without calling any Provider', async () => {
    const provider = new Provider(output('character:alice', 'must not be dispatched'))
    const value = await fixture([binding('character:alice', provider)])
    const cycleId = value.store.activeReactionCycle(value.spec.manifest.address)!.cycle.cycleId
    value.store.cancelReactionCycle(value.spec.manifest.address, cycleId)
    await expect(value.scheduler.runCurrentWave()).resolves.toMatchObject({
      terminalReason: 'user_cancelled', actionCount: 0,
    })
    expect(provider.calls).toBe(0)
    expect(value.store.readReactionCycle(value.spec.manifest.address, cycleId)?.cycle)
      .toMatchObject({ status: 'terminal', terminalReason: 'user_cancelled' })
    close(value)
  })

  it('resumes durable ProviderCall states without a second dispatch', async () => {
    const states = ['dispatch_started', 'response_received', 'validated', 'committed', 'provider_rejected'] as const
    for (const state of states) {
      const provider = new Provider(output('character:alice', `unused ${state}`))
      const value = await fixture([binding('character:alice', provider)])
      value.contexts.onReceipt = receipt => {
        const prepared = value.providerCalls.prepare(receipt)
        value.providerCalls.markDispatchStarted(prepared.modelCallId)
        if (state === 'response_received' || state === 'validated' || state === 'committed') {
          value.providerCalls.recordResponse(prepared.modelCallId, output('character:alice', `stored ${state}`), { stored: state })
        }
        if (state === 'validated' || state === 'committed') {
          value.providerCalls.markValidated(prepared.modelCallId, output('character:alice', `stored ${state}`))
        }
        if (state === 'committed') {
          value.providerCalls.markCommitted(
            prepared.modelCallId, 'transaction:fixture', hashWorldJson('authority', 'fixture'),
          )
        }
        if (state === 'provider_rejected') {
          value.providerCalls.markTerminal(prepared.modelCallId, state, { stored: state })
        }
      }
      const result = await value.scheduler.runCurrentWave()
      expect(provider.calls).toBe(0)
      expect(result?.terminalReason).toBe(
        state === 'response_received' || state === 'validated' ? 'quiescent' : 'provider_terminal',
      )
      close(value)
    }
  })

  it('enforces timeout, duplicate Action, private audience, and every Cycle terminal budget', async () => {
    const timedOutProvider: ReactionAgentProvider = { propose: async () => new Promise<SubmitActionsV2>(() => undefined) }
    const timeoutBinding = { ...binding('character:alice', timedOutProvider), timeoutMs: 1 }
    const timedOut = await fixture([timeoutBinding])
    await expect(timedOut.scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'provider_terminal' })
    close(timedOut)

    const duplicate = await fixture([
      binding('character:alice', new Provider({
        ...output('character:alice', 'one'),
        actions: [{ ...output('character:alice', 'one').actions[0]!, actionId: 'action:same' }],
      })),
      binding('character:bob', new Provider({
        ...output('character:bob', 'two'),
        actions: [{ ...output('character:bob', 'two').actions[0]!, actionId: 'action:same' }],
      })),
    ])
    await expect(duplicate.scheduler.runCurrentWave()).rejects.toThrow('actionId')
    close(duplicate)

    const privateSpeech: SubmitActionsV2 = {
      ...output('character:alice', 'Private answer.'),
      actions: [{
        ...output('character:alice', 'Private answer.').actions[0]!,
        parameters: { text: 'Private answer.', scope: 'private', addresseeIds: ['character:bob'] },
      }],
    }
    const privateValue = await fixture([
      binding('character:alice', new Provider(privateSpeech)),
      binding('character:bob', new Provider(abstain())),
    ])
    await privateValue.scheduler.runCurrentWave()
    expect(privateValue.store.readOutbox(privateValue.spec.manifest.address)[0]?.payload)
      .toMatchObject({ value: { content: { contentVisibility: 'occurrence_only' } } })
    close(privateValue)

    let requestCancel = () => undefined as unknown
    const cancellingProvider = new Provider(output('character:alice', 'cancelled'), undefined, () => { requestCancel() })
    const cancelled = await fixture([binding('character:alice', cancellingProvider)])
    requestCancel = () => cancelled.store.cancelReactionCycle(
      cancelled.spec.manifest.address,
      cancelled.store.activeReactionCycle(cancelled.spec.manifest.address)!.cycle.cycleId,
    )
    await expect(cancelled.scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'user_cancelled' })
    close(cancelled)

    const deadlineClock = { value: 100 }
    const deadline = await fixture([binding('character:alice', new Provider(output('character:alice', 'late')))], deadlineClock, {
      cycle: { deadlineAtMs: 101 },
    })
    deadlineClock.value = 101
    await expect(deadline.scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'deadline_reached' })
    close(deadline)

    const waveLimit = await fixture([
      binding('character:alice', new Provider(output('character:alice', 'wave'))),
      binding('character:bob', new Provider(abstain())),
    ], { value: 100 }, { cycle: { maxWaves: 1 } })
    await expect(waveLimit.scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'wave_limit' })
    close(waveLimit)

    const callLimit = await fixture([
      binding('character:alice', new Provider(output('character:alice', 'call'))),
      binding('character:bob', new Provider(abstain())),
    ], { value: 100 }, { cycle: { maxNpcCalls: 1 } })
    await expect(callLimit.scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'call_limit' })
    close(callLimit)

    const tokenLimit = await fixture([
      binding('character:alice', new Provider(output('character:alice', 'token'))),
      binding('character:bob', new Provider(abstain())),
    ], { value: 100 }, { cycle: { initialTokenBudget: 2 } })
    await expect(tokenLimit.scheduler.runCurrentWave()).resolves.toMatchObject({ terminalReason: 'token_budget_exhausted' })
    close(tokenLimit)
  })

  it('runs fault hooks and fails closed if the Cycle vanishes before commit', async () => {
    const points: string[] = []
    const faultInjector: FaultInjector = { hit: point => { points.push(point) } }
    const hooked = await fixture([binding('character:alice', new Provider(abstain()))], { value: 100 }, { faultInjector })
    await hooked.scheduler.runCurrentWave()
    expect(points).toEqual([
      'provider.before-dispatch', 'provider.after-dispatch', 'provider.after-response', 'provider.before-world-commit',
    ])
    close(hooked)

    const afterClaims = await fixture([binding('character:alice', new Provider(abstain()))])
    const absentAfterClaims = proxyStore(afterClaims.store, { readReactionCycle: () => undefined })
    await expect(new ReactionScheduler({ ...afterClaims.schedulerOptions, store: absentAfterClaims }).runCurrentWave())
      .rejects.toThrow('disappeared after Wave claims')
    close(afterClaims)

    const disappearing = await fixture([binding('character:alice', new Provider(abstain()))])
    let reads = 0
    const disappearingStore = proxyStore(disappearing.store, {
      readReactionCycle: (...args: Parameters<WorldStore['readReactionCycle']>) => {
        reads += 1
        return reads === 1 ? disappearing.store.readReactionCycle(...args) : undefined
      },
    })
    await expect(new ReactionScheduler({ ...disappearing.schedulerOptions, store: disappearingStore }).runCurrentWave())
      .rejects.toThrow('disappeared before Wave commit')
    close(disappearing)
  })
})
