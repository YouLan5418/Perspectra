import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextReceiptStore,
  createContextReceipt,
  ProviderCallStore,
  ProviderQualityStore,
} from '@harness-world/agents'
import {
  brandId,
  deterministicId,
  failWorld,
  hashWorldJson,
  PHASE8_REGISTRY_LOCKS,
  PHASE8_VOCABULARY_LOCKS,
  type AgentProvider,
  type CharacterId,
  type FaultInjector,
  type FaultPoint,
  type InteractionRoundId,
  type Proposal,
  type ProposalContext,
  type SubmitActionsV2,
  type SubmitActionsV3,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  currentEntityState,
  manifestationManifestRegistries,
  phase8ManifestRegistries,
  RulebookRegistry,
  WorldBootstrap,
  WorldSpecCompiler,
  type CompiledWorldSpec,
  type RoundExecutionLane,
} from '@harness-world/kernel'
import { BranchAdministration, CharacterRuntimeAvailabilityService, CognitionProjectionRebuilder, RoundInbox, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import {
  RoundCoordinator,
  compareActionOrderKey,
  parseClaimedPlayerAction,
  parseClaimedPlayerSubmission,
  sortActionOrderKeys,
  type ActionOrderKey,
  type RoundCoordinatorOptions,
  type RoundParticipant,
} from './round-coordinator.ts'
import { SceneDecisionService } from './scene-decision.ts'
import type { Phase8ProviderContext } from './context-pipeline.ts'
import { WorldApplication } from './world-application.ts'
import { v5Manifest } from '../../../tests/reaction-fixture.ts'

const directories: string[] = []

class ThrowAfterCommitOnce implements FaultInjector {
  #fired = false

  hit(point: FaultPoint): void {
    if (point !== 'store.after-commit' || this.#fired) return
    this.#fired = true
    throw new Error('simulated failure after committed coordinated Round')
  }
}

function database(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-round-coordinator-'))
  directories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function world(): CompiledWorldSpec {
  return new WorldSpecCompiler().compile({
    schemaVersion: 1,
    address: { tenantId: 'tenant:coordinator', worldId: 'world:coordinator', branchId: 'branch:main' },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 8,
    rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
    locations: [
      { locationId: 'location:a', name: 'Alpha' },
      { locationId: 'location:b', name: 'Beta' },
    ],
    characters: [
      { characterId: 'character:player', name: 'Player', locationId: 'location:a' },
      { characterId: 'character:npc', name: 'NPC', locationId: 'location:a' },
    ],
    playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
    plugins: [],
  })
}

function entityWorld(): CompiledWorldSpec {
  return new WorldSpecCompiler().compile({
    schemaVersion: 2,
    address: { tenantId: 'tenant:coordinator', worldId: 'world:competition-v2', branchId: 'branch:main' },
    metadata: { title: 'Take competition', description: '' },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 8,
    runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
    rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
    locations: [{ locationId: 'location:a', name: 'Alpha' }],
    entities: [{ entityId: 'entity:key', locationId: 'location:a', kind: 'key' }],
    characters: [
      { characterId: 'character:player', name: 'Player', locationId: 'location:a' },
      { characterId: 'character:fast', name: 'Fast', locationId: 'location:a' },
      { characterId: 'character:slow', name: 'Slow', locationId: 'location:a' },
    ],
    scenes: [], goals: [], claims: [], observations: [],
    playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
    plugins: [],
  })
}

function phase8SceneWorld(): CompiledWorldSpec {
  const base = new WorldSpecCompiler().compile({
    schemaVersion: 2,
    address: { tenantId: 'tenant:coordinator', worldId: 'world:scene-v2', branchId: 'branch:main' },
    metadata: { title: 'Scene v2', description: '' }, timeMode: 'TURN_DRIVEN', roundQueueLimit: 8,
    runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
    rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
    locations: [{ locationId: 'location:a', name: 'Alpha' }], entities: [],
    characters: [
      { characterId: 'character:player', name: 'Player', locationId: 'location:a' },
      { characterId: 'character:npc', name: 'NPC', locationId: 'location:a' },
      { characterId: 'character:witness', name: 'Witness', locationId: 'location:a' },
      { characterId: 'character:other', name: 'Other', locationId: 'location:a' },
    ],
    scenes: [{
      sceneId: 'scene:a',
      participantIds: ['character:player', 'character:npc', 'character:witness', 'character:other'],
    }],
    goals: [], claims: [], observations: [],
    playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
    plugins: [],
  })
  const manifest = {
    ...base.manifest,
    registries: phase8ManifestRegistries(),
    contentPack: { runtimeCapabilities: { publicSpeechObservationVersion: 1 } },
  } as unknown as CompiledWorldSpec['manifest']
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { ...event.data as Record<string, WorldJsonValue>, manifestHash } }
    : event.eventType === 'scene.upsert'
    ? {
        ...event,
        data: {
          sceneId: 'scene:a',
          value: {
            lifecycle: 'active', locationId: 'location:a',
            participantIds: ['character:player', 'character:npc', 'character:witness', 'character:other'],
          },
        },
      }
    : event)
  return {
    manifest, manifestHash, genesisEvents,
    genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
  }
}

function phase8ReflectionWorld(): CompiledWorldSpec {
  const base = phase8SceneWorld()
  const manifest = {
    ...base.manifest,
    schemaVersion: 4 as const,
    plugins: [
      { pluginId: 'builtin:agent-context', version: '2.0.0' },
      { pluginId: 'builtin:scene-decision', version: '2.0.0' },
    ],
    contentPack: {
      schemaVersion: 2 as const, packId: 'pack:reflection-test', packVersion: '1.0.0',
      packHash: hashWorldJson('pack', { id: 'reflection-test' }),
      compiler: {
        id: 'test-compiler', version: '1.0.0', contractVersion: 'worldpack/v2',
        canonicalJsonVersion: 'world-json/v1', limitsProfile: 'worldpack-limits/v2',
      },
      pluginLocks: [], vocabularyLocks: PHASE8_VOCABULARY_LOCKS, registryLocks: PHASE8_REGISTRY_LOCKS,
      runtimeCapabilities: {
        publicSpeechObservationVersion: 1 as const, cognitionProjectionVersion: 1 as const,
        sceneDecisionVersion: 2 as const, cognitiveMemoryVersion: 2 as const, agentContextVersion: 2 as const,
      },
      presentation: { schemaVersion: 'worldpack-presentation/v1', locale: 'en', style: 'plain' },
      initialFacts: [], memory: [], documents: [], markdown: [],
    },
  }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(value => value.eventType === 'world.manifest-locked'
    ? { ...value, data: { ...(value.data as WorldJsonObject), manifestHash } }
    : value)
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

function manifestationWorld(groups = false): CompiledWorldSpec {
  const base = phase8ReflectionWorld()
  const manifest = {
    ...base.manifest,
    schemaVersion: groups ? 7 as const : 6 as const,
    ...(groups ? { actionGroupPolicy: { version: 'bounded-action-group/v1' } } : {}),
    registries: manifestationManifestRegistries(),
    reactionPolicy: { version: 'reaction-policy/v1' as const, mode: 'disabled' as const },
    manifestationPolicy: { version: 'manifestation-policy/v1' as const, mode: 'enabled' as const },
  }
  if (groups) {
    Object.assign(manifest, { locations: [...manifest.locations, { locationId: 'location:b', name: 'Next room' }] })
  }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(value => value.eventType === 'world.manifest-locked'
    ? { ...value, data: { ...(value.data as WorldJsonObject), manifestHash } }
    : value)
  if (groups) genesisEvents.push({ eventType: 'location.upsert', eventVersion: 1, data: { locationId: 'location:b', name: 'Next room' } } as never,
    { eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: 'scene:next', value: { lifecycle: 'active', locationId: 'location:b', participantIds: [] } } } as never)
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

function lane(compiled: CompiledWorldSpec): RoundExecutionLane {
  let tail: Promise<void> = Promise.resolve()
  return {
    address: compiled.manifest.address,
    manifestHash: compiled.manifestHash,
    enqueueRound<T>(work: () => Promise<T>): Promise<T> {
      const result = tail.then(work, work)
      tail = result.then(() => undefined, () => undefined)
      return result
    },
  }
}

function provider(propose: (context: ProposalContext) => Proposal | Promise<Proposal>): AgentProvider {
  return { propose: async context => propose(context) }
}

function actionProposal(participantId: string, actionId: string, actionType: string, parameters: WorldJsonValue): Proposal {
  return {
    participantId,
    actions: [{
      actionId,
      actorId: brandId('character:npc', 'CharacterId'),
      actionType,
      actionVersion: 1,
      parameters,
    }],
  }
}

function participant(
  participantId: string,
  role: 'agent' | 'director',
  priority: number,
  agent: AgentProvider,
): RoundParticipant {
  return {
    participantId,
    role,
    actorId: brandId('character:npc', 'CharacterId'),
    allowedActionTypes: ['speak', 'move'],
    priority,
    estimatedTokens: 1,
    timeoutMs: 100,
    provider: agent,
  }
}

function options(
  path: string,
  compiled: CompiledWorldSpec,
  participants: readonly RoundParticipant[] = [],
  modelBudgetTokens = 100,
  configuration: {
    readonly now?: () => number
    readonly leaseTtlMs?: number
    readonly faultInjector?: FaultInjector
  } = {},
): RoundCoordinatorOptions & {
  store: WorldStore
  inbox: RoundInbox
  leases: WriterLeaseService
  availability: CharacterRuntimeAvailabilityService
  providerCalls?: ProviderCallStore
  providerQuality?: ProviderQualityStore
} {
  const now = configuration.now ?? Date.now
  const store = new WorldStore(path, configuration.faultInjector, now)
  const inbox = new RoundInbox(path, now)
  const leases = new WriterLeaseService(path, now)
  const availability = new CharacterRuntimeAvailabilityService(path, now)
  const providerCalls = compiled.manifest.schemaVersion >= 4 ? new ProviderCallStore(`${path}.context.sqlite`) : undefined
  const providerQuality = compiled.manifest.schemaVersion >= 4 ? new ProviderQualityStore(`${path}.context.sqlite`, now) : undefined
  if (store.readManifest(compiled.manifest.address) !== undefined) {
    availability.initialize(compiled.manifest.address, compiled.manifest.characters.map(value => ({ characterId: value.characterId, state: 'ready' })))
  }
  return {
    store,
    inbox,
    leases,
    availability,
    runtimeLane: lane(compiled),
    ownerId: 'coordinator:test',
    participants,
    modelBudgetTokens,
    ...(providerCalls === undefined ? {} : { providerCalls }),
    ...(providerQuality === undefined ? {} : { providerQuality }),
    ...(configuration.faultInjector === undefined ? {} : { faultInjector: configuration.faultInjector }),
    ...(configuration.leaseTtlMs === undefined ? {} : { leaseTtlMs: configuration.leaseTtlMs }),
  }
}

function close(optionsValue: ReturnType<typeof options>, coordinator?: RoundCoordinator): void {
  coordinator?.close()
  optionsValue.inbox.close()
  optionsValue.availability.close()
  optionsValue.providerCalls?.close()
  optionsValue.providerQuality?.close()
  optionsValue.leases.close()
  optionsValue.store.close()
}

/**
 * A Phase 8 world with durable Provider call and quality boundaries, an authoritative Scene decision and a
 * scripted Context receipt, so a Round can reach dispatch without a real Context pipeline.
 */
function phase8RetryFixture(
  path: string,
  compiled: CompiledWorldSpec,
  participants: readonly RoundParticipant[],
): {
  readonly configured: ReturnType<typeof options>
  readonly sceneDecision: never
  readonly contextPipeline: never
  readonly cognitiveMemory: never
} {
  const configured = options(path, compiled, participants)
  const sceneDecision = {
    decideFromEvents: (address: unknown, player: CharacterId, _events: unknown, asOfSeq: number) => {
      const characterIds = compiled.manifest.characters.map(character => character.characterId)
      return {
        sceneId: 'scene:a', observerIds: [player, ...characterIds.filter(id => id !== player)],
        schedulableCharacterIds: characterIds.filter(id => id !== player),
        visibleResultCharacterIds: characterIds, asOfSeq,
      }
    },
  } as never
  const contextPipeline = {
    prepare: (
      binding: RoundParticipant, context: ProposalContext, _history: unknown, _decision: unknown,
      asOf: number, heartbeat: () => void,
    ) => {
      heartbeat()
      const cognition = new CognitionProjectionRebuilder(configured.store)
        .rebuildCharacterAt(context.address, binding.actorId, asOf)
      const receipt = createContextReceipt({
        address: context.address, roundId: context.roundId, participantKind: 'character',
        participantId: binding.participantId, subjectCharacterId: binding.actorId,
        controllerId: `provider:${binding.participantId}`, controllerEpoch: 1,
        baseHeadSeq: asOf, asOfWorldSeq: asOf, tick: context.tick, manifestHash: compiled.manifestHash,
        contextProfileId: 'standard', contextProfileHash: hashWorldJson('profile', { id: 'standard' }),
        versionLocks: {
          contextSchema: 'character-controller/v2', contextReceiptSchema: 'context-receipt/v1',
          sceneDecisionSchema: 'scene-decision/v2', memorySchema: 'cognitive-memory/v2',
          checkpointSchema: 'continuity-checkpoint/v1', rendererSchema: 'structured-prompt-renderer/v1',
        },
        componentHashes: {
          characterViewHash: cognition.bundleHash, sceneDecisionHash: hashWorldJson('scene', { asOf }),
          checkpointHash: null, tailHash: hashWorldJson('tail', {}), recallHash: hashWorldJson('recall', {}),
          affordanceHash: hashWorldJson('affordance', {}),
        },
        includedSourceRefs: [], exclusions: [],
        contextHash: hashWorldJson('context', { candidateHash: context.candidateHash, asOf }),
        providerRequestHash: hashWorldJson('provider', { candidateHash: context.candidateHash, asOf }),
      })
      return {
        providerContext: {
          ...context, agentContextVersion: 2, participantId: binding.participantId,
          contextReceiptId: receipt.receiptId, contextHash: receipt.contextHash,
          providerRequestHash: receipt.providerRequestHash,
          exactProviderRequest: {
            schemaVersion: 'structured-provider-request/v1', model: 'scripted', messages: [], tools: {},
            sampling: {}, user: 'opaque',
          },
        },
        receipt, cognition, memorySourceRefs: [], recallResultHash: hashWorldJson('recall', {}),
      }
    },
  } as never
  const cognitiveMemory = { processPending: () => ({ completed: 0, failed: [] }) } as never
  return { configured, sceneDecision, contextPipeline, cognitiveMemory }
}

/** A scripted Phase 8 abstaining participant whose Provider fails only while `state.fail` is true. */
function retryParticipant(actorId: CharacterId, state: { fail: boolean; calls: number }): RoundParticipant {
  return {
    participantId: 'agent:recovering', role: 'agent', actorId,
    allowedActionTypes: ['speak', 'move'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
    provider: {
      async propose() {
        state.calls += 1
        if (state.fail) throw new Error('provider offline')
        return { schemaVersion: 2 as const, decision: 'abstain' as const, actions: [] }
      },
    },
  }
}

async function installCommittedRecoveryFixture(
  path: string,
  compiled: CompiledWorldSpec,
  suffix: string,
  mutation: 'round_id' | 'missing_player' | 'invalid_result' | 'invalid_reason' | 'rejected',
) {
  const request = {
    idempotencyKey: `round:malformed:${suffix}`,
    principalId: 'principal:player',
    action: { actionType: 'speak', parameters: { text: suffix } },
    correlationId: `malformed:${suffix}`,
  } as const
  const inbox = new RoundInbox(path)
  const queued = inbox.enqueue({
    address: compiled.manifest.address,
    idempotencyKey: request.idempotencyKey,
    principalId: request.principalId,
    input: request.action,
    correlationId: request.correlationId,
  }, compiled.manifest.roundQueueLimit)
  const leases = new WriterLeaseService(path)
  const lease = leases.acquire(compiled.manifest.address, 'fixture:malformed')
  inbox.claimNext(compiled.manifest.address, lease.ownerId, lease.fencingToken)
  const identity = {
    address: compiled.manifest.address,
    inboxSeq: queued.inboxSeq,
    idempotencyKey: request.idempotencyKey,
    inputHash: queued.inputHash,
  }
  const transactionId = brandId(deterministicId('transaction:coordinated-round', identity), 'TransactionId')
  const expectedRoundId = brandId(deterministicId('round:coordinated', identity), 'InteractionRoundId')
  const committedRoundId = mutation === 'round_id'
    ? brandId(`round:wrong:${suffix}`, 'InteractionRoundId')
    : expectedRoundId
  const playerActionId = deterministicId('action:coordinated-player', {
    roundId: expectedRoundId,
    inboxSeq: queued.inboxSeq,
  })
  const store = new WorldStore(path)
  const head = store.head(compiled.manifest.address)
  await store.commitRound({
    address: compiled.manifest.address,
    transactionId,
    roundId: committedRoundId,
    expectedHeadSeq: head.headSeq,
    expectedTick: head.tick,
    nextTick: head.tick + 1,
    events: [{
      eventType: 'action.resolved',
      eventVersion: 1,
      data: {
        roundId: expectedRoundId,
        actionId: playerActionId,
        participantId: 'player',
        actorId: 'character:player',
        actionType: 'speak',
        sourceRole: mutation === 'missing_player' ? 'agent' : 'player',
        order: 0,
        accepted: mutation === 'invalid_result' ? 'yes' : mutation !== 'rejected',
        reason: mutation === 'invalid_reason' ? 1 : mutation === 'rejected' ? 'denied' : null,
      },
    }],
    outbox: [],
    correlationId: request.correlationId,
    admissionProof: { inboxSeq: queued.inboxSeq, inputHash: queued.inputHash },
    writerFencingToken: lease.fencingToken,
  })
  leases.release(compiled.manifest.address, lease.ownerId, lease.fencingToken)
  store.close()
  leases.close()
  inbox.close()
  return request
}

describe('RoundCoordinator', () => {
  it('retains speech before a rejected move and resolves contested take groups without interleaving', async () => {
    const path = database('group-contention.sqlite')
    const base = manifestationWorld(true)
    const entity = { entityId: 'entity:cup', kind: 'cup', locationId: 'location:a' }
    const manifest = { ...base.manifest, entities: [entity] }
    const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
    const genesisEvents = [...base.genesisEvents.map(e => e.eventType === 'world.manifest-locked' ? { ...e, data: { ...e.data as WorldJsonObject, manifestHash } } : e), { eventType: 'entity.upsert', eventVersion: 1, data: entity }]
    const compiled = { ...base, manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    let round = 0
    const participants: RoundParticipant[] = ['character:npc', 'character:witness'].map((id, index) => ({
      participantId: `agent:${id}`, role: 'agent', actorId: brandId(id, 'CharacterId'),
      allowedActionTypes: ['speak', 'move', 'take'], priority: 2 - index, estimatedTokens: 1, timeoutMs: 100,
      provider: { async propose() {
        if (round === 1) return index === 0 ? { schemaVersion: 4, decision: 'act', actions: [
          { actionId: 'z:farewell', actorId: id, actionType: 'speak', actionVersion: 1, parameters: { text: 'goodbye' } },
          { actionId: 'a:missing', actorId: id, actionType: 'move', actionVersion: 1, parameters: { locationId: 'missing' } },
        ] } : { schemaVersion: 4, decision: 'abstain', actions: [] }
        return { schemaVersion: 4, decision: 'act', actions: [
          { actionId: `z:take:${index}`, actorId: id, actionType: 'take', actionVersion: 1, parameters: { entityId: 'entity:cup' } },
          { actionId: `a:speak:${index}`, actorId: id, actionType: 'speak', actionVersion: 1, parameters: { text: `mine:${index}` } },
        ] }
      } },
    }))
    const configured = options(path, compiled, participants)
    const coordinator = new RoundCoordinator({ ...configured, sceneDecision: new SceneDecisionService(configured.store, configured.availability, 2) })
    try {
      const request = { principalId: 'principal:player', action: { actionType: 'speak', parameters: { text: 'go' } }, correlationId: 'group:contention' }
      await coordinator.submit({ ...request, idempotencyKey: 'take' })
      round = 1
      await coordinator.submit({ ...request, idempotencyKey: 'farewell' })
      const events = configured.store.readEvents(compiled.manifest.address)
      expect(events.filter(e => e.eventType === 'entity.taken')).toHaveLength(1)
      const speech = events.filter(e => e.eventType === 'character.speak').map(e => (e.data as WorldJsonObject).text)
      expect(speech).toContain('mine:0')
      expect(speech).not.toContain('mine:1')
      expect(speech).toContain('goodbye')
      const ids = events.filter(e => e.eventType === 'action.resolved').map(e => (e.data as WorldJsonObject).actionId)
      expect(ids.slice(1, 5)).toEqual(['z:take:0', 'a:speak:0', 'z:take:1', 'a:speak:1'])
      expect(ids.slice(-2)).toEqual(['z:farewell', 'a:missing'])
    } finally { close(configured, coordinator) }
  })

  it.each([false, true])('resolves a bounded group in proposal order and durably skips dependent speech after rejection (%s)', async rejected => {
    const path = database('action-group.sqlite')
    const compiled = manifestationWorld(true)
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    const npc: RoundParticipant = {
      participantId: 'agent:group', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak', 'move'], priority: 0, estimatedTokens: 1, timeoutMs: 100,
      provider: { async propose() { return { schemaVersion: 4, decision: 'act', actions: [
        { actionId: 'z:move', actorId: 'character:npc', actionType: 'move', actionVersion: 1,
          parameters: { locationId: rejected ? 'missing' : 'location:b' },
          manifestation: { independent: ['frown'], onSuccess: ['slow_walk'] } },
        { actionId: 'a:speak', actorId: 'character:npc', actionType: 'speak', actionVersion: 1,
          parameters: { text: 'arrived' }, manifestation: { independent: [], onSuccess: ['quiet_voice'] } },
      ] } } },
    }
    const configured = options(path, compiled, [npc])
    const coordinator = new RoundCoordinator({ ...configured, sceneDecision: new SceneDecisionService(configured.store, configured.availability, 2) })
    const request = { idempotencyKey: 'group', principalId: 'principal:player', action: { actionType: 'speak', parameters: { text: 'go' } }, correlationId: 'group' }
    await coordinator.submit(request)
    await coordinator.submit(request)
    const events = configured.store.readEvents(compiled.manifest.address)
    const resolutions = events.filter(e => e.eventType === 'action.resolved')
    expect(resolutions.slice(1).map(e => (e.data as WorldJsonObject).actionId)).toEqual(['z:move', 'a:speak'])
    const transactionId = resolutions[0]!.transactionId
    const authority = configured.store.readRoundAuthority(compiled.manifest.address, transactionId)!.authority as any
    expect(authority.schemaVersion).toBe(4)
    expect(authority.resolutions.slice(1).map((r: any) => r.status)).toEqual(rejected ? ['rejected', 'skipped'] : ['accepted', 'accepted'])
    const observations = events.filter(e => e.eventType === 'observation.upsert').map(e => (e.data as any).value)
    if (rejected) {
      expect(observations.filter(o => o.actionId === 'a:speak').map(o => o.observerId)).toEqual(['character:npc'])
      expect(JSON.stringify(observations)).not.toContain('arrived')
      expect(JSON.stringify(observations)).not.toContain('移动时步伐缓慢')
    } else expect(JSON.stringify(observations)).toContain('arrived')
    const participantRow = authority.participants.find((p: any) => p.participantId === npc.participantId)
    const proposal = { participantId: npc.participantId, actions: authority.actions.filter((a: any) => a.participantId === npc.participantId).map((a: any) => ({ actionId: a.actionId, actorId: a.actorId, actionType: a.actionType, actionVersion: a.actionVersion, parameters: a.parameters })), actionGroup: participantRow.actionGroup }
    expect(hashWorldJson('round-participant-proposal', proposal)).toBe(participantRow.proposalHash)
    close(configured, coordinator)
    const reopened = new WorldStore(path)
    expect(reopened.readRoundAuthority(compiled.manifest.address, transactionId)!.authority).toEqual(authority)
    reopened.close()
  })

  it('does not synthesize a Cycle when a low-level responsive coordinator has no Reaction bindings', async () => {
    const path = database('responsive-no-reaction-bindings.sqlite')
    const compiled = v5Manifest()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    const coordinatorOptions = options(path, compiled)
    const coordinator = new RoundCoordinator(coordinatorOptions)
    try {
      await expect(coordinator.submit({
        idempotencyKey: 'responsive:no-bindings',
        principalId: 'principal:player',
        action: { actionType: 'speak', parameters: { text: 'no bindings' } },
        correlationId: 'responsive:no-bindings',
      })).resolves.toMatchObject({ status: 'accepted' })
      expect(coordinatorOptions.store.activeReactionCycle(compiled.manifest.address)).toBeUndefined()
    } finally {
      close(coordinatorOptions, coordinator)
    }
  })

  it('freezes Scene v2 participants but recomputes full and redacted observations at each action prefix', async () => {
    const path = database('scene-v2.sqlite')
    const compiled = phase8SceneWorld()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    const registry = new RulebookRegistry()
    registry.register('builtin:speak-move', 2, {
      resolve(context) {
        const player = context.characterId === 'character:player'
        return {
          status: 'accepted',
          ...(player ? {} : { reason: 'PRIVATE_REASON_CANARY' }),
          events: [
            { eventType: 'character.speak', eventVersion: 1, data: { characterId: context.characterId, text: player ? 'leave now' : 'private reply' } },
            ...(player ? [{
              eventType: 'scene.member_left', eventVersion: 1,
              data: { sceneId: 'scene:a', characterId: 'character:witness' },
            }] : []),
          ],
          ...(player ? {} : { observationScope: { scope: 'private' as const, recipientIds: ['character:player'] } }),
        }
      },
      affordances: () => [{ actionType: 'speak', actionVersion: 1 }],
    })
    const configured = options(path, compiled, [
      participant('agent:npc', 'agent', 1, provider(context => actionProposal(
        'agent:npc', `action:npc:${context.roundId}`, 'speak', { text: 'private reply' },
      ))),
    ])
    const coordinator = new RoundCoordinator({
      ...configured,
      rulebooks: registry,
      sceneDecision: new SceneDecisionService(configured.store, configured.availability, 2),
    })
    await expect(coordinator.submit({
      idempotencyKey: 'scene-prefix', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'leave now' } }, correlationId: 'scene-prefix',
    })).resolves.toMatchObject({ status: 'accepted' })
    const observations = configured.store.readEvents(compiled.manifest.address)
      .filter(event => event.eventType === 'observation.upsert')
      .map(event => (event.data as Record<string, WorldJsonValue>).value as Record<string, WorldJsonValue>)
    const forCharacter = (characterId: string) => observations.filter(value => value.observerId === characterId)
    close(configured, coordinator)
    expect(forCharacter('character:witness')).toHaveLength(1)
    expect(forCharacter('character:player')).toHaveLength(2)
    expect(forCharacter('character:npc')).toHaveLength(2)
    expect(forCharacter('character:other')).toHaveLength(2)
    expect(forCharacter('character:other')[1]).toMatchObject({
      content: { actionType: 'private_interaction', contentVisibility: 'occurrence_only' },
    })
    expect(JSON.stringify(forCharacter('character:other')[1])).not.toContain('private reply')
    expect(JSON.stringify(forCharacter('character:other')[1])).not.toContain('PRIVATE_REASON_CANARY')
    expect(forCharacter('character:other')[1]!.content).not.toHaveProperty('reason')
    expect(JSON.stringify(forCharacter('character:player')[1])).toContain('private reply')
    expect(JSON.stringify(forCharacter('character:player')[1])).toContain('PRIVATE_REASON_CANARY')
  })

  it('commits v3 manifestation authority, observable facts, state transitions, and independent action outcomes', async () => {
    const path = database('manifestation-v3.sqlite')
    const compiled = manifestationWorld()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    let call = 0
    const npc: RoundParticipant = {
      participantId: 'agent:manifestation', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak', 'move'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
      provider: {
        async propose(): Promise<SubmitActionsV3> {
          call += 1
          return call === 1 ? {
            schemaVersion: 3, decision: 'act',
            actions: [{
              actionId: 'action:manifested-speech', actorId: 'character:npc',
              actionType: 'speak', actionVersion: 1, parameters: { text: '随你。' },
            }],
            manifestation: {
              description: 'NPC 抱起双臂，避开玩家的视线，冷淡地开口。',
              cues: [
                { cueId: 'cue:gaze', channel: 'gaze', description: '避开玩家的视线', persistence: 'event_only' },
                {
                  cueId: 'cue:posture', channel: 'posture', description: '抱起双臂', persistence: 'until_changed',
                  stateKey: 'posture:arms-crossed', operation: 'set',
                },
              ],
            },
          } : {
            schemaVersion: 3, decision: 'act',
            actions: [{
              actionId: 'action:rejected-move', actorId: 'character:npc',
              actionType: 'move', actionVersion: 1, parameters: { locationId: 'location:missing' },
            }],
            manifestation: {
              cues: [{ cueId: 'cue:frown', channel: 'facial', description: '皱了皱眉', persistence: 'event_only' }],
            },
          }
        },
      },
    }
    const configured = options(path, compiled, [npc])
    const coordinator = new RoundCoordinator({
      ...configured,
      sceneDecision: new SceneDecisionService(configured.store, configured.availability, 2),
    })
    await coordinator.submit({
      idempotencyKey: 'manifestation:first', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: '发生了什么？' } }, correlationId: 'manifestation:first',
    })
    await coordinator.submit({
      idempotencyKey: 'manifestation:rejected-action', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: '去不存在的地方。' } }, correlationId: 'manifestation:second',
    })
    const history = configured.store.readEvents(compiled.manifest.address)
    const manifested = history.filter(value => value.eventType === 'character.manifested')
    expect(manifested).toHaveLength(2)
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'character.visible-state-upserted' }),
    ]))
    const rejectedMove = history.find(value => value.eventType === 'action.resolved'
      && (value.data as WorldJsonObject).actionId === 'action:rejected-move')!
    expect(rejectedMove.data).toMatchObject({ accepted: false, manifestationStatus: 'accepted' })
    const fullObservation = history.find(value => value.eventType === 'observation.upsert'
      && JSON.stringify(value.data).includes('action:manifested-speech')
      && JSON.stringify(value.data).includes('character:player'))!
    expect(fullObservation.data).toMatchObject({ value: { content: { manifestation: {
      description: 'NPC 抱起双臂，避开玩家的视线，冷淡地开口。',
    } } } })
    const firstAuthority = configured.store.readRoundAuthority(
      compiled.manifest.address, manifested[0]!.transactionId,
    )!.authority as any
    expect(firstAuthority.participants.find((value: any) => value.participantId === npc.participantId))
      .toHaveProperty('manifestation')
    expect(firstAuthority.actions.find((value: any) => value.actionId === 'action:manifested-speech'))
      .toHaveProperty('manifestation')
    expect(firstAuthority.resolutions.find((value: any) => value.actionId === 'action:manifested-speech'))
      .toMatchObject({ manifestation: { status: 'accepted' } })
    close(configured, coordinator)
  })

  it('commits manual-player manifestation and exposes it only through the authorized proposal context and observations', async () => {
    const path = database('player-manifestation.sqlite')
    const compiled = manifestationWorld()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    let seen: ProposalContext | undefined
    const npc: RoundParticipant = {
      participantId: 'agent:player-witness', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
      provider: { async propose(context): Promise<SubmitActionsV3> {
        seen = context
        return { schemaVersion: 3, decision: 'abstain', actions: [] }
      } },
    }
    const configured = options(path, compiled, [npc])
    const coordinator = new RoundCoordinator({
      ...configured,
      sceneDecision: new SceneDecisionService(configured.store, configured.availability, 2),
    })
    const manifestation = {
      description: '玩家皱了皱眉，避开 NPC 的视线。',
      cues: [
        { cueId: 'cue:player-frown', channel: 'facial', description: '皱了皱眉', persistence: 'event_only' },
        { cueId: 'cue:player-gaze', channel: 'gaze', description: '避开 NPC 的视线', persistence: 'event_only' },
      ],
    } as const
    const request = {
      idempotencyKey: 'player-manifestation:first', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: '随你。' } }, manifestation,
      correlationId: 'player-manifestation:first',
    } as const
    const result = await coordinator.submit(request)
    expect(result.status).toBe('accepted')
    expect(seen?.playerManifestation).toEqual(manifestation)
    const manifested = configured.store.readEvents(compiled.manifest.address)
      .find(event => event.eventType === 'character.manifested')!
    expect(manifested.data).toMatchObject({ characterId: 'character:player', description: manifestation.description })
    const authority = configured.store.readRoundAuthority(
      compiled.manifest.address, manifested.transactionId,
    )!.authority as any
    expect(authority.participants.find((value: any) => value.participantId === 'player'))
      .toMatchObject({ manifestation })
    expect(authority.actions[0]).toMatchObject({ sourceRole: 'player', manifestation })
    expect(authority.resolutions[0]).toMatchObject({ manifestation: { status: 'accepted' } })
    expect(configured.store.readEvents(compiled.manifest.address).filter(event => event.eventType === 'observation.upsert'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ value: expect.objectContaining({
          content: expect.objectContaining({ manifestation: expect.objectContaining({ characterId: 'character:player' }) }),
        }) }) }),
      ]))
    await expect(coordinator.submit(request)).resolves.toEqual(result)
    expect(() => coordinator.submit({
      ...request,
      manifestation: { ...manifestation, description: '同键改写表现。' },
      correlationId: 'player-manifestation:diverged',
    })).toThrow('different player input')
    close(configured, coordinator)
  })

  it('rejects player manifestation without capability and malformed durable wrappers fail closed', () => {
    const compiled = phase8ReflectionWorld()
    const path = database('player-manifestation-disabled.sqlite')
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    const configured = options(path, compiled)
    const coordinator = new RoundCoordinator(configured)
    const request = {
      idempotencyKey: 'player-manifestation:disabled', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: '随你。' } },
      manifestation: { cues: [{ cueId: 'cue:1', channel: 'facial', description: '皱眉', persistence: 'event_only' }] },
      correlationId: 'player-manifestation:disabled',
    } as const
    expect(() => coordinator.submit(request)).toThrow('enabled Manifest capability')
    expect(() => parseClaimedPlayerSubmission(null)).toThrow('must be an object')
    expect(() => parseClaimedPlayerSubmission({ action: request.action })).toThrow('invalid shape')
    expect(() => parseClaimedPlayerSubmission({ action: request.action, manifestation: { cues: [] } }))
      .toThrow('between 1 and 8')
    expect(parseClaimedPlayerSubmission(request.action)).toEqual({ action: request.action })
    close(configured, coordinator)
  })

  it('reports a durably claimed Round as processing without executing it again', () => {
    const compiled = world()
    const path = database('accepted-processing.sqlite')
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    const coordinatorOptions = options(path, compiled)
    const coordinator = new RoundCoordinator(coordinatorOptions)
    const request = {
      idempotencyKey: 'round:accepted-processing', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'queued' } }, correlationId: 'accepted-processing',
    } as const
    expect(coordinator.accept(request)).toMatchObject({ status: 'queued', inboxSeq: 1 })
    const lease = coordinatorOptions.leases.acquire(compiled.manifest.address, coordinatorOptions.ownerId)
    expect(coordinatorOptions.inbox.claimNext(compiled.manifest.address, lease.ownerId, lease.fencingToken))
      .toMatchObject({ inboxSeq: 1 })
    expect(coordinator.accept(request)).toMatchObject({ status: 'processing', inboxSeq: 1 })
    close(coordinatorOptions, coordinator)
  })

  it('validates durable actions and compares every stable ActionOrderKey field', () => {
    expect(parseClaimedPlayerAction({ actionType: 'speak', parameters: {} })).toEqual({ actionType: 'speak', parameters: {} })
    for (const invalid of [null, [], 'action', { actionType: 1, parameters: {} }, { actionType: 'speak' }]) {
      expect(() => parseClaimedPlayerAction(invalid as never)).toThrow(TypeError)
    }
    const base: ActionOrderKey = {
      sourceRole: 'agent', priority: 1,
      actorId: brandId('character:b', 'CharacterId'), actionId: 'action:b',
    }
    expect(compareActionOrderKey({ ...base, sourceRole: 'player' }, base)).toBeLessThan(0)
    expect(compareActionOrderKey({ ...base, priority: 2 }, base)).toBeLessThan(0)
    expect(compareActionOrderKey({ ...base, actorId: brandId('character:a', 'CharacterId') }, base)).toBeLessThan(0)
    expect(compareActionOrderKey({ ...base, actionId: 'action:a' }, base)).toBeLessThan(0)
    expect(compareActionOrderKey(base, base)).toBe(0)
  })

  it('freezes one cross-platform ActionOrderKey Golden without a player row', () => {
    const astral = brandId('character:\u{10000}', 'CharacterId')
    const privateUse = brandId('character:\uE000', 'CharacterId')
    const keys: readonly ActionOrderKey[] = [
      { sourceRole: 'agent', priority: 1, actorId: privateUse, actionId: 'action:z' },
      { sourceRole: 'agent', priority: 2, actorId: privateUse, actionId: 'action:priority' },
      { sourceRole: 'agent', priority: 1, actorId: astral, actionId: 'action:b' },
      { sourceRole: 'agent', priority: 1, actorId: astral, actionId: 'action:a' },
    ]
    const ordered = sortActionOrderKeys(keys)
    expect(ordered.map(value => value.actionId)).toEqual([
      'action:priority', 'action:a', 'action:b', 'action:z',
    ])
    expect(keys[0]!.actionId).toBe('action:z')
    const golden = ordered.map(value => ({
      sourceRole: value.sourceRole, priority: value.priority,
      actorId: value.actorId, actionId: value.actionId,
    }) satisfies WorldJsonObject)
    expect(hashWorldJson('reaction-action-order-key-golden/v1', golden))
      .toBe('sha256:727da7bdfb0957d2ad9450dd7f3dd4503eebb3167b3429d9c5d7a84b105612b2')
    expect(sortActionOrderKeys([...keys].reverse())).toEqual(ordered)
  })

  it('freezes player, Agent, and Director terminals, re-resolves in stable order, and replays durably', async () => {
    const path = database('coordinated.sqlite')
    const compiled = world()
    const bootstrap = new WorldStore(path)
    new WorldBootstrap(bootstrap).activate(compiled)
    bootstrap.close()
    let providerCalls = 0
    const counted = (value: (context: ProposalContext) => Proposal | Promise<Proposal>): AgentProvider =>
      provider(async context => {
        providerCalls += 1
        return value(context)
      })
    const participants = [
      participant('director:exhausted', 'director', 1, counted(() => actionProposal('director:exhausted', 'action:never', 'speak', { text: 'never' }))),
      participant('agent:invalid', 'agent', 80, counted(() => ({
        participantId: 'agent:invalid',
        actions: [{ actionId: 'action:invalid', actorId: brandId('character:other', 'CharacterId'), actionType: 'move', actionVersion: 1, parameters: {} }],
      }))),
      participant('agent:move', 'agent', 100, counted(() => actionProposal('agent:move', 'action:npc-move', 'move', { locationId: 'location:b' }))),
      participant('director:move', 'director', 10, counted(() => actionProposal('director:move', 'action:director-move', 'move', { locationId: 'location:b' }))),
      participant('agent:failed', 'agent', 95, counted(async () => { throw new Error('provider offline') })),
      participant('agent:duplicate', 'agent', 90, counted(context => actionProposal('agent:duplicate', context.playerAction.actionId, 'speak', { text: 'duplicate' }))),
    ]
    const firstOptions = options(path, compiled, participants, 4)
    const coordinator = new RoundCoordinator(firstOptions)
    const request = {
      idempotencyKey: 'round:one',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'hello' } },
      correlationId: 'coordinated-round',
    } as const
    const result = await coordinator.submit(request)
    expect(result).toMatchObject({ status: 'accepted', tick: 1 })
    expect(providerCalls).toBe(5)
    expect(await coordinator.submit(request)).toEqual(result)
    expect(providerCalls).toBe(5)
    expect(coordinator.accept(request)).toMatchObject({ status: 'committed', idempotencyKey: 'round:one' })
    const administration = new BranchAdministration(path)
    administration.setAdmission(compiled.manifest.address, 'draining', 'retry proof', 'coordinator:draining')
    expect(await coordinator.submit(request)).toEqual(result)
    expect(() => coordinator.submit({
      ...request,
      idempotencyKey: 'round:draining-new',
      correlationId: 'coordinator:draining-new',
    })).toThrow('branch admission is draining')
    administration.setAdmission(compiled.manifest.address, 'open', 'resume', 'coordinator:open')
    administration.close()

    const events = firstOptions.store.readEvents(compiled.manifest.address)
    const terminals = events.filter(value => value.eventType === 'round.participant-terminal').map(value => value.data)
    expect(terminals).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: 'agent:move', status: 'proposed', actionCount: 1 }),
      expect.objectContaining({ participantId: 'agent:failed', status: 'provider_failed', actionCount: 0 }),
      expect.objectContaining({ participantId: 'agent:duplicate', status: 'schema_invalid', actionCount: 0 }),
      expect.objectContaining({ participantId: 'agent:invalid', status: 'schema_invalid', actionCount: 0 }),
      expect.objectContaining({ participantId: 'director:move', status: 'proposed', actionCount: 1 }),
      expect.objectContaining({ participantId: 'director:exhausted', status: 'budget_exhausted', actionCount: 0 }),
    ]))
    const resolutions = events.filter(value => value.eventType === 'action.resolved')
    expect(resolutions.map(value => value.data)).toEqual([
      expect.objectContaining({ sourceRole: 'player', order: 0, accepted: true }),
      expect.objectContaining({ participantId: 'agent:move', order: 1, accepted: true }),
      expect.objectContaining({ participantId: 'director:move', order: 2, accepted: false }),
    ])
    const authority = firstOptions.store.readRoundAuthority(compiled.manifest.address, resolutions[0]!.transactionId)
    expect(authority).toMatchObject({ roundId: expect.any(String), authorityHash: expect.stringMatching(/^sha256:/) })
    const authorityData = authority!.authority as any
    expect(authorityData.schemaVersion).toBe(2)
    expect(authorityData.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: 'player', terminalStatus: 'proposed', providerInvocationId: null }),
      expect.objectContaining({
        participantId: 'agent:move', terminalStatus: 'proposed',
        providerInvocationId: expect.any(String), budgetEvaluationId: expect.any(String),
        modelReplayRecordHash: null, budgetReservationRecordHash: null,
        responseHash: expect.stringMatching(/^sha256:/),
      }),
      expect.objectContaining({ participantId: 'agent:failed', terminalStatus: 'provider_failed' }),
    ]))
    expect(authorityData.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: 'player', proposalOrdinal: 0, parameters: { text: 'hello' }, orderKey: expect.objectContaining({ phase: 0, roleRank: 0 }) }),
      expect.objectContaining({ participantId: 'agent:move', proposalOrdinal: 0, orderKey: expect.objectContaining({ phase: 1, roleRank: 1 }) }),
      expect.objectContaining({ participantId: 'director:move', proposalOrdinal: 0, orderKey: expect.objectContaining({ phase: 1, roleRank: 2 }) }),
    ]))
    expect(authorityData.resolutions).toEqual([
      expect.objectContaining({ status: 'accepted', candidateHashBefore: expect.any(String), candidateHashAfter: expect.any(String), ruleTraceHash: expect.any(String) }),
      expect.objectContaining({ status: 'accepted' }),
      expect.objectContaining({ status: 'rejected', candidateHashBefore: expect.any(String), candidateHashAfter: expect.any(String) }),
    ])
    expect(firstOptions.store.readOutbox(compiled.manifest.address)).toHaveLength(3)
    const eventHashes = events.map(value => value.eventHash)
    close(firstOptions, coordinator)

    const restartedOptions = options(path, compiled, participants, 4)
    const restarted = new RoundCoordinator(restartedOptions)
    expect(await restarted.submit(request)).toEqual(result)
    expect(providerCalls).toBe(5)
    expect(restartedOptions.store.readEvents(compiled.manifest.address).map(value => value.eventHash)).toEqual(eventHashes)
    expect(restartedOptions.store.readRoundAuthority(compiled.manifest.address, resolutions[0]!.transactionId)).toEqual(authority)
    close(restartedOptions, restarted)
  })

  it('preserves proposal-local action order while recording the distinct global resolution order', async () => {
    const path = database('multi-action-authority.sqlite')
    const compiled = world()
    const bootstrap = new WorldStore(path)
    new WorldBootstrap(bootstrap).activate(compiled)
    bootstrap.close()
    const multiAction = participant('agent:multi', 'agent', 1, provider(() => ({
      participantId: 'agent:multi',
      actions: [
        {
          actionId: 'action:z', actorId: brandId('character:npc', 'CharacterId'),
          actionType: 'speak', actionVersion: 1, parameters: { text: 'first proposed' },
        },
        {
          actionId: 'action:a', actorId: brandId('character:npc', 'CharacterId'),
          actionType: 'speak', actionVersion: 1, parameters: { text: 'second proposed' },
        },
      ],
    })))
    const coordinatorOptions = options(path, compiled, [multiAction])
    const coordinator = new RoundCoordinator(coordinatorOptions)
    await coordinator.submit({
      idempotencyKey: 'round:multi-action', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'begin' } }, correlationId: 'multi-action',
    })
    const transactionId = coordinatorOptions.store.readEvents(compiled.manifest.address)
      .find(value => value.eventType === 'action.resolved')!.transactionId
    const authority = coordinatorOptions.store.readRoundAuthority(compiled.manifest.address, transactionId)!.authority as any
    const participantRecord = authority.participants.find((value: any) => value.participantId === 'agent:multi')
    const actions = authority.actions.filter((value: any) => value.participantId === 'agent:multi')
    expect(actions.map((value: any) => value.actionId)).toEqual(['action:a', 'action:z'])
    expect(actions.map((value: any) => value.proposalOrdinal)).toEqual([1, 0])
    const reconstructedProposal = {
      participantId: 'agent:multi',
      actions: [...actions]
        .sort((left: any, right: any) => left.proposalOrdinal - right.proposalOrdinal)
        .map((value: any) => ({
          actionId: value.actionId,
          actorId: value.actorId,
          actionType: value.actionType,
          actionVersion: value.actionVersion,
          parameters: value.parameters,
        })),
    }
    expect(hashWorldJson('round-participant-proposal', reconstructedProposal)).toBe(participantRecord.proposalHash)
    close(coordinatorOptions, coordinator)
  })

  it('re-resolves two same-Round take actions against the accepted prefix', async () => {
    const path = database('take-competition.sqlite')
    const compiled = entityWorld()
    const bootstrap = new WorldStore(path)
    new WorldBootstrap(bootstrap).activate(compiled)
    bootstrap.close()
    const takeParticipant = (participantId: string, actorId: string, priority: number): RoundParticipant => ({
      participantId,
      role: 'agent',
      actorId: brandId(actorId, 'CharacterId'),
      allowedActionTypes: ['take'], priority, estimatedTokens: 1, timeoutMs: 100,
      provider: provider(() => ({
        participantId,
        actions: [{
          actionId: `action:${participantId}:take`, actorId: brandId(actorId, 'CharacterId'),
          actionType: 'take', actionVersion: 1, parameters: { entityId: 'entity:key' },
        }],
      })),
    })
    const coordinatorOptions = options(path, compiled, [
      takeParticipant('agent:slow', 'character:slow', 1),
      takeParticipant('agent:fast', 'character:fast', 2),
    ])
    const coordinator = new RoundCoordinator(coordinatorOptions)
    await coordinator.submit({
      idempotencyKey: 'round:take-competition', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'take it' } }, correlationId: 'take-competition',
    })
    const events = coordinatorOptions.store.readEvents(compiled.manifest.address)
    expect(currentEntityState(events, 'entity:key')).toEqual({
      entityId: 'entity:key', kind: 'key', locationId: null, holderId: 'character:fast',
    })
    expect(events.filter(value => value.eventType === 'entity.taken')).toHaveLength(1)
    expect(events.filter(value => value.eventType === 'action.resolved').map(value => value.data)).toEqual([
      expect.objectContaining({ participantId: 'player', accepted: true, order: 0 }),
      expect.objectContaining({ participantId: 'agent:fast', accepted: true, order: 1 }),
      expect.objectContaining({ participantId: 'agent:slow', accepted: false, reason: 'ITEM_NOT_AVAILABLE', order: 2 }),
    ])
    close(coordinatorOptions, coordinator)
  })

  it('records deterministic absence without calling providers for unavailable or non-active NPCs', async () => {
    let calls = 0
    const npc = participant('agent:eligibility', 'agent', 1, provider(() => {
      calls += 1
      return actionProposal('agent:eligibility', 'action:eligibility', 'speak', { text: 'must not run' })
    }))

    const runtimePath = database('runtime-unavailable.sqlite')
    const compiled = world()
    const runtimeSetup = new WorldStore(runtimePath)
    new WorldBootstrap(runtimeSetup).activate(compiled)
    runtimeSetup.close()
    const runtimeOptions = options(runtimePath, compiled, [npc])
    runtimeOptions.availability.set(compiled.manifest.address, npc.actorId, 'offline', 'provider disconnected')
    const runtimeCoordinator = new RoundCoordinator(runtimeOptions)
    await runtimeCoordinator.submit({
      idempotencyKey: 'runtime-unavailable', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'turn' } }, correlationId: 'runtime-unavailable',
    })
    expect(calls).toBe(0)
    expect(runtimeOptions.store.readEvents(compiled.manifest.address).some(event =>
      event.eventType === 'round.participant-terminal'
      && JSON.stringify(event.data).includes('runtime_unavailable'))).toBe(true)
    close(runtimeOptions, runtimeCoordinator)

    const lifecyclePath = database('lifecycle-ineligible.sqlite')
    const lifecycleSetup = new WorldStore(lifecyclePath)
    new WorldBootstrap(lifecycleSetup).activate(compiled)
    const head = lifecycleSetup.head(compiled.manifest.address)
    await lifecycleSetup.commitRound({
      address: compiled.manifest.address,
      transactionId: brandId('transaction:npc-dead', 'TransactionId'),
      roundId: brandId('round:npc-dead', 'InteractionRoundId'),
      expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
      events: [{ eventType: 'character.lifecycle-changed', eventVersion: 1, data: { characterId: npc.actorId, lifecycleState: 'dead' } }],
      outbox: [], correlationId: 'npc-dead',
    })
    lifecycleSetup.close()
    const lifecycleOptions = options(lifecyclePath, compiled, [npc])
    const lifecycleCoordinator = new RoundCoordinator(lifecycleOptions)
    await lifecycleCoordinator.submit({
      idempotencyKey: 'lifecycle-ineligible', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'turn' } }, correlationId: 'lifecycle-ineligible',
    })
    expect(calls).toBe(0)
    expect(lifecycleOptions.store.readEvents(compiled.manifest.address).some(event =>
      event.eventType === 'round.participant-terminal'
      && JSON.stringify(event.data).includes('lifecycle_ineligible'))).toBe(true)
    close(lifecycleOptions, lifecycleCoordinator)
  })

  it('uses the formal Phase 8 Context result and records its receipt in Round Authority', async () => {
    const path = database('phase8-context-success.sqlite')
    const compiled = world()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    let received: ProposalContext | undefined
    const npc = participant('agent:phase8', 'agent', 1, provider(context => {
      received = context
      return { participantId: 'agent:phase8', actions: [] }
    }))
    const configured = options(path, compiled, [npc])
    const sceneDecision = {
      decideFromEvents: (_address: unknown, player: typeof npc.actorId, _events: unknown, asOfSeq: number) => ({
        sceneId: 'scene:test', observerIds: [player, npc.actorId], schedulableCharacterIds: [npc.actorId],
        visibleResultCharacterIds: [player, npc.actorId], asOfSeq,
      }),
    } as never
    const contextPipeline = {
      prepare: (
        _binding: RoundParticipant,
        context: ProposalContext,
        _history: unknown,
        _decision: unknown,
        _asOf: number,
        heartbeat: () => void,
      ) => {
        heartbeat()
        return {
        providerContext: {
          ...context, agentContextVersion: 2, participantId: npc.participantId,
          contextReceiptId: 'receipt:phase8', contextHash: hashWorldJson('context', { phase8: true }),
          providerRequestHash: hashWorldJson('provider', { phase8: true }),
          exactProviderRequest: {
            schemaVersion: 'structured-provider-request/v1', model: 'scripted', messages: [], tools: {},
            sampling: {}, user: 'opaque',
          },
        },
        receipt: {
          receiptId: 'receipt:phase8', contextHash: hashWorldJson('context', { phase8: true }),
          providerRequestHash: hashWorldJson('provider', { phase8: true }),
        },
          memorySourceRefs: [], recallResultHash: hashWorldJson('recall', {}),
        }
      },
    } as never
    const coordinator = new RoundCoordinator({ ...configured, sceneDecision, contextPipeline })
    await coordinator.submit({
      idempotencyKey: 'phase8-context', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'hello' } }, correlationId: 'phase8-context',
    })
    const transactionId = configured.store.readEvents(compiled.manifest.address)
      .find(event => event.eventType === 'action.resolved')!.transactionId
    const authority = configured.store.readRoundAuthority(compiled.manifest.address, transactionId)!.authority as any
    expect(received).toMatchObject({ agentContextVersion: 2, contextReceiptId: 'receipt:phase8' })
    expect(authority.participants.find((value: any) => value.participantId === npc.participantId)).toMatchObject({
      contextReceiptId: 'receipt:phase8', providerRequestHash: hashWorldJson('provider', { phase8: true }),
    })
    close(configured, coordinator)
  })

  it('commits accepted Reflection after external observations and keeps rejected Reflection separate from legal actions', async () => {
    const path = database('phase8-reflection.sqlite')
    const compiled = phase8ReflectionWorld()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    let call = 0
    let includeCognition = true
    let currentBasis = {
      sourceKind: 'world_event', sourceId: 'event:0', sourceSeq: 0,
      sourceHash: hashWorldJson('placeholder', {}),
    }
    const npc: RoundParticipant = {
      participantId: 'agent:reflection', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak', 'move'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
      provider: {
        async propose(context) {
          call += 1
          const validBasis = call === 1
            ? currentBasis
            : { ...currentBasis, sourceId: 'event:forbidden' }
          const reflection: SubmitActionsV2['reflection'] = {
            operations: [{
              operationId: `operation:${call}`, kind: 'subjective-claim', recordId: `claim:reflection:${call}`,
              expectedStateHash: null, basisRefs: [validBasis],
              value: {
                proposition: `Alice believes turn ${call}`, stance: 'believed', confidencePermille: 500,
                saliencePermille: 500, awareness: 'conscious', status: 'active',
              },
            }],
          }
          return call === 1
            ? { schemaVersion: 2 as const, decision: 'abstain' as const, actions: [], reflection }
            : {
                schemaVersion: 2 as const, decision: 'act' as const,
                actions: [{
                  actionId: call === 4 ? context.playerAction.actionId : 'action:npc:second',
                  actorId: npc.actorId, actionType: 'speak', actionVersion: 1,
                  parameters: { text: 'The legal action still happens' },
                }],
                reflection,
              }
        },
      },
    }
    const configured = options(path, compiled, [npc])
    const sceneDecision = {
      decideFromEvents: (_address: unknown, player: typeof npc.actorId, _events: unknown, asOfSeq: number) => ({
        sceneId: 'scene:a', observerIds: [player, npc.actorId], schedulableCharacterIds: [npc.actorId],
        visibleResultCharacterIds: [player, npc.actorId], asOfSeq,
      }),
    } as never
    const contextPipeline = {
      prepare: (
        binding: RoundParticipant,
        context: ProposalContext,
        history: ReturnType<WorldStore['readEvents']>,
        _decision: unknown,
        asOfWorldSeq: number,
        heartbeat: () => void,
      ) => {
        heartbeat()
        const last = history.at(-1)!
        currentBasis = {
          sourceKind: 'world_event', sourceId: `event:${last.seq}`, sourceSeq: last.seq, sourceHash: last.eventHash,
        }
        const cognition = new CognitionProjectionRebuilder(configured.store)
          .rebuildCharacterAt(context.address, binding.actorId, asOfWorldSeq)
        const receipt = createContextReceipt({
          address: context.address, roundId: context.roundId, participantKind: 'character', participantId: binding.participantId,
          subjectCharacterId: binding.actorId, controllerId: `provider:${binding.participantId}`, controllerEpoch: 1,
          baseHeadSeq: asOfWorldSeq, asOfWorldSeq, tick: context.tick, manifestHash: compiled.manifestHash,
          contextProfileId: 'standard', contextProfileHash: hashWorldJson('profile', { id: 'standard' }),
          versionLocks: {
            contextSchema: 'character-controller/v2', contextReceiptSchema: 'context-receipt/v1', sceneDecisionSchema: 'scene-decision/v2',
            memorySchema: 'cognitive-memory/v2', checkpointSchema: 'continuity-checkpoint/v1', rendererSchema: 'structured-prompt-renderer/v1',
          },
          componentHashes: {
            characterViewHash: cognition.bundleHash, sceneDecisionHash: hashWorldJson('scene', { asOfWorldSeq }), checkpointHash: null,
            tailHash: hashWorldJson('tail', {}), recallHash: hashWorldJson('recall', {}), affordanceHash: hashWorldJson('affordance', {}),
          },
          includedSourceRefs: [currentBasis], exclusions: [], contextHash: hashWorldJson('context', { candidateHash: context.candidateHash, asOfWorldSeq }),
          providerRequestHash: hashWorldJson('provider', { candidateHash: context.candidateHash, asOfWorldSeq }),
        })
        return {
          providerContext: {
            ...context, agentContextVersion: 2, participantId: binding.participantId,
            contextReceiptId: receipt.receiptId, contextHash: receipt.contextHash, providerRequestHash: receipt.providerRequestHash,
            exactProviderRequest: { schemaVersion: 'structured-provider-request/v1', model: 'scripted', messages: [], tools: {}, sampling: {}, user: 'opaque' },
          },
          receipt, ...(includeCognition ? { cognition } : {}),
          memorySourceRefs: [], recallResultHash: hashWorldJson('recall', {}),
        }
      },
    } as never
    const cognitiveMemory = {
      processPending: () => ({ completed: 0, failed: [] }),
    } as never
    const coordinator = new RoundCoordinator({ ...configured, sceneDecision, contextPipeline, cognitiveMemory })
    await coordinator.submit({
      idempotencyKey: 'reflection:first', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'first' } }, correlationId: 'reflection:first',
    })
    const firstEvents = configured.store.readEvents(compiled.manifest.address)
    const reflected = firstEvents.find(value => value.eventType === 'character.reflect')!
    const firstTransactionEvents = firstEvents.filter(value => value.transactionId === reflected.transactionId)
    expect(reflected.seq).toBeGreaterThan(Math.max(...firstTransactionEvents.filter(value => value.eventType === 'observation.upsert').map(value => value.seq)))
    expect(reflected.seq).toBeLessThan(firstTransactionEvents.find(value => value.eventType === 'world.tick-advanced')!.seq)
    expect(new CognitionProjectionRebuilder(configured.store).rebuildCharacterAt(
      compiled.manifest.address, npc.actorId, configured.store.head(compiled.manifest.address).headSeq,
    ).claims).toMatchObject([{ id: 'claim:reflection:1' }])
    const firstAuthority = configured.store.readRoundAuthority(compiled.manifest.address, reflected.transactionId)!.authority as any
    const firstParticipant = firstAuthority.participants.find((value: any) => value.participantId === npc.participantId)
    expect(firstParticipant.cognitivePolicyReceipt)
      .toMatchObject({ status: 'accepted', reasonCode: 'accepted' })
    expect(configured.providerCalls!.read(firstParticipant.providerInvocationId)).toMatchObject({
      state: 'committed', transactionId: reflected.transactionId,
    })
    const providerDatabase = new DatabaseSync(`${path}.context.sqlite`)
    providerDatabase.prepare(`
      UPDATE provider_calls SET state = 'validated', transaction_id = NULL, authority_hash = NULL
      WHERE model_call_id = ?
    `).run(firstParticipant.providerInvocationId)
    coordinator.reconcileCommittedProviderCalls(reflected.transactionId)
    expect(configured.providerCalls!.read(firstParticipant.providerInvocationId)).toMatchObject({ state: 'committed' })

    await coordinator.submit({
      idempotencyKey: 'reflection:second', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'second' } }, correlationId: 'reflection:second',
    })
    const allEvents = configured.store.readEvents(compiled.manifest.address)
    expect(allEvents.filter(value => value.eventType === 'character.reflect')).toHaveLength(1)
    const npcSpeech = allEvents.find(value => value.eventType === 'character.speak'
      && (value.data as WorldJsonObject).characterId === npc.actorId
      && (value.data as WorldJsonObject).text === 'The legal action still happens')!
    const secondAuthority = configured.store.readRoundAuthority(compiled.manifest.address, npcSpeech.transactionId)!.authority as any
    const secondParticipant = secondAuthority.participants.find((value: any) => value.participantId === npc.participantId)
    expect(secondParticipant.cognitivePolicyReceipt)
      .toMatchObject({ status: 'rejected', reasonCode: 'source_forbidden' })
    expect(configured.providerCalls!.read(secondParticipant.providerInvocationId)).toMatchObject({ state: 'committed' })

    includeCognition = false
    await coordinator.submit({
      idempotencyKey: 'reflection:missing-prefix', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'third' } }, correlationId: 'reflection:missing-prefix',
    })
    const thirdEvents = configured.store.readEvents(compiled.manifest.address)
    expect(thirdEvents.filter(value => value.eventType === 'character.reflect')).toHaveLength(1)
    const thirdTransaction = thirdEvents.filter(value => value.eventType === 'round.participant-terminal').at(-1)!.transactionId
    const thirdAuthority = configured.store.readRoundAuthority(compiled.manifest.address, thirdTransaction)!.authority as any
    const thirdParticipant = thirdAuthority.participants.find((value: any) => value.participantId === npc.participantId)
    expect(configured.providerCalls!.read(thirdParticipant.providerInvocationId)).toMatchObject({ state: 'invalid_response' })

    includeCognition = true
    configured.availability.set(compiled.manifest.address, npc.actorId, 'ready', null)
    await coordinator.submit({
      idempotencyKey: 'reflection:duplicate-action', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'fourth' } }, correlationId: 'reflection:duplicate-action',
    })
    const fourthEvents = configured.store.readEvents(compiled.manifest.address)
    const fourthTransaction = fourthEvents.filter(value => value.eventType === 'round.participant-terminal').at(-1)!.transactionId
    const fourthAuthority = configured.store.readRoundAuthority(compiled.manifest.address, fourthTransaction)!.authority as any
    const fourthParticipant = fourthAuthority.participants.find((value: any) => value.participantId === npc.participantId)
    expect(configured.providerCalls!.read(fourthParticipant.providerInvocationId)).toMatchObject({ state: 'invalid_response' })
    providerDatabase.prepare('DELETE FROM provider_calls WHERE model_call_id = ?').run(firstParticipant.providerInvocationId)
    coordinator.reconcileCommittedProviderCalls(reflected.transactionId)
    providerDatabase.close()
    expect(call).toBe(4)
    close(configured, coordinator)
  })

  it.each(['prepared_budget', 'dispatch_started', 'response_received', 'invalid_response', 'validated'] as const)(
    'recovers Provider call state %s without redispatch', async recoveredState => {
    const path = database(`phase8-provider-${recoveredState}.sqlite`)
    const compiled = phase8ReflectionWorld()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    let calls = 0
    const npc: RoundParticipant = {
      participantId: 'agent:ambiguous', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
      provider: { async propose() { calls += 1; return { schemaVersion: 2, decision: 'abstain', actions: [] } } },
    }
    const configured = options(path, compiled, [npc], recoveredState === 'prepared_budget' ? 0 : 100)
    const sceneDecision = {
      decideFromEvents: (_address: unknown, player: typeof npc.actorId, _events: unknown, asOfSeq: number) => ({
        sceneId: 'scene:a', observerIds: [player, npc.actorId], schedulableCharacterIds: [npc.actorId],
        visibleResultCharacterIds: [player, npc.actorId], asOfSeq,
      }),
    } as never
    const makeReceipt = (roundId: InteractionRoundId, tick: number) => {
      const head = configured.store.head(compiled.manifest.address)
      const cognition = new CognitionProjectionRebuilder(configured.store)
        .rebuildCharacterAt(compiled.manifest.address, npc.actorId, head.headSeq)
      const contextHash = hashWorldJson('ambiguous-context', { roundId, tick })
      const providerRequestHash = hashWorldJson('ambiguous-provider', { roundId, tick })
      return {
        cognition,
        receipt: createContextReceipt({
          address: compiled.manifest.address, roundId, participantKind: 'character',
          participantId: npc.participantId, subjectCharacterId: npc.actorId,
          controllerId: `provider:${npc.participantId}`, controllerEpoch: 1,
          baseHeadSeq: head.headSeq, asOfWorldSeq: head.headSeq, tick, manifestHash: compiled.manifestHash,
          contextProfileId: 'standard', contextProfileHash: hashWorldJson('profile', { id: 'standard' }),
          versionLocks: {
            contextSchema: 'character-controller/v2', contextReceiptSchema: 'context-receipt/v1', sceneDecisionSchema: 'scene-decision/v2',
            memorySchema: 'cognitive-memory/v2', checkpointSchema: 'continuity-checkpoint/v1', rendererSchema: 'structured-prompt-renderer/v1',
          },
          componentHashes: {
            characterViewHash: cognition.bundleHash, sceneDecisionHash: hashWorldJson('scene', { head: head.headSeq }), checkpointHash: null,
            tailHash: hashWorldJson('tail', {}), recallHash: hashWorldJson('recall', {}), affordanceHash: hashWorldJson('affordance', {}),
          },
          includedSourceRefs: [], exclusions: [], contextHash, providerRequestHash,
        }),
      }
    }
    const contextPipeline = {
      prepare: (binding: RoundParticipant, context: ProposalContext) => {
        const prepared = makeReceipt(context.roundId, context.tick)
        return {
          providerContext: {
            ...context, agentContextVersion: 2, participantId: binding.participantId,
            contextReceiptId: prepared.receipt.receiptId, contextHash: prepared.receipt.contextHash,
            providerRequestHash: prepared.receipt.providerRequestHash,
            exactProviderRequest: { schemaVersion: 'structured-provider-request/v1', model: 'scripted', messages: [], tools: {}, sampling: {}, user: 'opaque' },
          },
          ...prepared, memorySourceRefs: [], recallResultHash: hashWorldJson('recall', {}),
        }
      },
    } as never
    const coordinator = new RoundCoordinator({ ...configured, sceneDecision, contextPipeline })
    const accepted = coordinator.accept({
      idempotencyKey: 'provider:ambiguous', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'continue safely' } }, correlationId: 'provider:ambiguous',
    })
    const prepared = configured.providerCalls!.prepare(makeReceipt(accepted.roundId, 1).receipt)
    if (recoveredState !== 'prepared_budget') configured.providerCalls!.markDispatchStarted(prepared.modelCallId)
    const rawResponse = recoveredState === 'validated' || recoveredState === 'invalid_response'
      ? { schemaVersion: 2, decision: 'abstain', actions: [{}] }
      : { schemaVersion: 2, decision: 'abstain', actions: [] }
    if (recoveredState === 'response_received' || recoveredState === 'invalid_response' || recoveredState === 'validated') {
      configured.providerCalls!.recordResponse(prepared.modelCallId, rawResponse, { provider: 'scripted' })
    }
    if (recoveredState === 'invalid_response') {
      configured.providerCalls!.markTerminal(prepared.modelCallId, 'invalid_response', { reason: 'fixture invalid response' })
    }
    if (recoveredState === 'validated') configured.providerCalls!.markValidated(prepared.modelCallId, rawResponse)
    if (recoveredState === 'validated') {
      await expect(coordinator.drainAccepted('provider:validated-divergence')).rejects.toThrow('no longer validates')
      expect(calls).toBe(0)
      expect(configured.providerCalls!.read(prepared.modelCallId)).toMatchObject({ state: 'validated' })
      close(configured, coordinator)
      return
    }
    await coordinator.drainAccepted('provider:ambiguous:recovery')
    expect(calls).toBe(0)
    expect(configured.providerCalls!.read(prepared.modelCallId)).toMatchObject({
      state: recoveredState === 'prepared_budget' ? 'budget_exhausted'
        : recoveredState === 'dispatch_started' ? 'timed_out_ambiguous'
        : recoveredState === 'invalid_response' ? 'invalid_response' : 'committed',
    })
    const authority = configured.store.readRoundAuthority(
      compiled.manifest.address,
      configured.store.readEvents(compiled.manifest.address).at(-1)!.transactionId,
    )!.authority as any
    expect(authority.participants.find((value: any) => value.participantId === npc.participantId))
      .toMatchObject(recoveredState === 'prepared_budget'
        ? { terminalStatus: 'budget_exhausted', providerCallState: 'budget_exhausted' }
        : recoveredState === 'dispatch_started'
          ? { terminalStatus: 'provider_timeout', providerCallState: 'timed_out_ambiguous' }
          : recoveredState === 'invalid_response'
            ? { terminalStatus: 'schema_invalid', providerCallState: 'invalid_response' }
          : { terminalStatus: 'proposed', providerCallState: 'validated' })
    close(configured, coordinator)
  })

  it('requires the durable Provider boundary for Phase 8 participants', () => {
    const path = database('phase8-provider-required.sqlite')
    const compiled = phase8ReflectionWorld()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    const npc = participant('agent:required', 'agent', 1, provider(() => ({
      participantId: 'agent:required', actions: [],
    })))
    const configured = options(path, compiled, [npc])
    expect(() => new RoundCoordinator({
      ...configured, contextPipeline: {} as never, providerCalls: undefined,
    } as never)).toThrow('durable Provider call and quality boundaries')
    close(configured)
  })

  it('backs off persistently invalid Phase 8 output and recovers through one deterministic probe', async () => {
    const worldPath = database('phase8-quality-world.sqlite')
    const sessionPath = `${worldPath}.session.sqlite`
    const memoryPath = `${worldPath}.memory.sqlite`
    const compiled = phase8ReflectionWorld()
    let calls = 0
    const application = new WorldApplication({
      worldPath, sessionPath, memoryPath, modelBudgetTokens: 100,
      participants: () => [{
        participantId: 'agent:quality', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
        allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
        provider: {
          async propose() {
            calls += 1
            return calls <= 3
              ? { schemaVersion: 2, decision: 'act', actions: 'invalid' } as never
              : { schemaVersion: 2 as const, decision: 'abstain' as const, actions: [] }
          },
        },
      }],
    })
    application.activate(compiled)
    for (let turn = 1; turn <= 3; turn += 1) {
      await expect(application.submit(compiled.manifest.address, {
        idempotencyKey: `quality:${turn}`, principalId: 'principal:player',
        action: { actionType: 'speak', parameters: { text: `turn ${turn}` } }, correlationId: `quality:${turn}`,
      })).resolves.toMatchObject({ status: 'accepted', tick: turn })
    }
    expect(calls).toBe(3)
    await expect(application.characterAvailability(
      compiled.manifest.address, brandId('character:npc', 'CharacterId'),
    )).resolves.toMatchObject({ state: 'provider_output_invalid' })

    await application.submit(compiled.manifest.address, {
      idempotencyKey: 'quality:backoff', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'backoff' } }, correlationId: 'quality:backoff',
    })
    expect(calls).toBe(3)
    await application.submit(compiled.manifest.address, {
      idempotencyKey: 'quality:probe', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'probe' } }, correlationId: 'quality:probe',
    })
    expect(calls).toBe(4)
    await expect(application.characterAvailability(
      compiled.manifest.address, brandId('character:npc', 'CharacterId'),
    )).resolves.toMatchObject({ state: 'ready', reason: null })
    await application.submit(compiled.manifest.address, {
      idempotencyKey: 'quality:backoff', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'backoff' } }, correlationId: 'quality:replay',
    })
    expect(calls).toBe(4)
    expect(application.runtimeMetrics.snapshot()).toMatchObject({
      participantTerminals: { schema_invalid: 2, provider_output_invalid: 2 },
    })
    await application.close()

    const quality = new ProviderQualityStore(`${memoryPath}.context.sqlite`)
    expect(quality.state(compiled.manifest.address, 'agent:quality')).toMatchObject({
      responseInvalidStreak: 0, responseBackoffLevel: 0, responseBackoffRemaining: 0,
    })
    expect(quality.readAudit(compiled.manifest.address, 'agent:quality').map(value => value.operation))
      .toEqual(expect.arrayContaining(['provider-quality.response-invalid', 'provider-quality.response-valid']))
    quality.close()
    const worldStore = new WorldStore(worldPath)
    expect(worldStore.readEvents(compiled.manifest.address).filter(event =>
      event.eventType === 'round.participant-terminal').map(event => (event.data as WorldJsonObject).status))
      .toEqual(['schema_invalid', 'schema_invalid', 'provider_output_invalid', 'provider_output_invalid', 'proposed'])
    worldStore.close()
  })

  it('suspends Reflection without suppressing a valid external Action', async () => {
    const worldPath = database('phase8-reflection-quality-world.sqlite')
    const sessionPath = `${worldPath}.session.sqlite`
    const memoryPath = `${worldPath}.memory.sqlite`
    const contextPath = `${memoryPath}.context.sqlite`
    const compiled = phase8ReflectionWorld()
    const seeded = new ProviderQualityStore(contextPath)
    for (let index = 1; index <= 3; index += 1) {
      seeded.recordReflection(compiled.manifest.address, 'agent:reflection-quality', `seed:${index}`, 'invalid')
    }
    seeded.close()
    const application = new WorldApplication({
      worldPath, sessionPath, memoryPath, modelBudgetTokens: 100,
      participants: () => [{
        participantId: 'agent:reflection-quality', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
        allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
        provider: {
          async propose(): Promise<SubmitActionsV2> {
            return {
              schemaVersion: 2, decision: 'act', reflection: { operations: [] },
              actions: [{
                actionId: 'action:reflection-suspended', actorId: brandId('character:npc', 'CharacterId'),
                actionType: 'speak', actionVersion: 1, parameters: { text: 'external action survives' },
              }],
            }
          },
        },
      }],
    })
    application.activate(compiled)
    await expect(application.submit(compiled.manifest.address, {
      idempotencyKey: 'reflection:suspended', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'continue' } }, correlationId: 'reflection:suspended',
    })).resolves.toMatchObject({ status: 'accepted', tick: 1 })
    await application.close()

    const worldStore = new WorldStore(worldPath)
    expect(worldStore.readEvents(compiled.manifest.address).some(event =>
      event.eventType === 'character.speak'
      && (event.data as WorldJsonObject).text === 'external action survives')).toBe(true)
    const transactionId = worldStore.readEvents(compiled.manifest.address).at(-1)!.transactionId
    const authority = worldStore.readRoundAuthority(compiled.manifest.address, transactionId)!.authority
    worldStore.close()
    expect(authority).toMatchObject({ participants: expect.arrayContaining([expect.objectContaining({
        participantId: 'agent:reflection-quality',
        providerQualityDecision: expect.objectContaining({
          policyId: 'provider-quality/v1', reflectionMode: 'suspended',
        }),
      })]) })
    const quality = new ProviderQualityStore(contextPath)
    expect(quality.state(compiled.manifest.address, 'agent:reflection-quality')).toMatchObject({
      reflectionInvalidStreak: 3, reflectionSuspensionRemaining: 3,
    })
    quality.close()
  })

  it('retries a lagging participant once its Context preparation succeeds and returns it to ready', async () => {
    const path = database('phase8-availability-recovery.sqlite')
    const compiled = phase8SceneWorld()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    const address = compiled.manifest.address
    const npcId = brandId('character:npc', 'CharacterId')
    let providerCalls = 0
    let preparationFails = true
    const npc = participant('agent:recovery', 'agent', 1, provider(() => {
      providerCalls += 1
      return { participantId: 'agent:recovery', actions: [] }
    }))
    const configured = options(path, compiled, [npc])
    configured.availability.set(address, npcId, 'session_lag', 'Memory catch-up is behind')
    configured.availability.set(address, brandId('character:other', 'CharacterId'), 'disabled', 'Host removed it')
    const sceneDecision = new SceneDecisionService(configured.store, configured.availability, 2)
    const decision = sceneDecision.decide(address, brandId('character:player', 'CharacterId'), configured.store.head(address).headSeq)
    expect(decision.schedulableCharacterIds).toContain(npcId)
    expect(decision.schedulableCharacterIds).not.toContain(brandId('character:other', 'CharacterId'))
    const contextPipeline = {
      prepare: (
        binding: RoundParticipant, context: ProposalContext, _history: unknown, _decision: unknown,
        _asOf: number, heartbeat: () => void,
      ) => {
        heartbeat()
        if (preparationFails) throw new Error('context offline')
        return {
          providerContext: {
            ...context, agentContextVersion: 2, participantId: binding.participantId,
            contextReceiptId: 'receipt:recovery', contextHash: hashWorldJson('context', { recovery: true }),
            providerRequestHash: hashWorldJson('provider', { recovery: true }),
            exactProviderRequest: {
              schemaVersion: 'structured-provider-request/v1', model: 'scripted', messages: [], tools: {},
              sampling: {}, user: 'opaque',
            },
          },
          receipt: {
            receiptId: 'receipt:recovery', contextHash: hashWorldJson('context', { recovery: true }),
            providerRequestHash: hashWorldJson('provider', { recovery: true }),
          },
          memorySourceRefs: [], recallResultHash: hashWorldJson('recall', {}),
        }
      },
    } as never
    const coordinator = new RoundCoordinator({ ...configured, sceneDecision, contextPipeline })
    const request = {
      principalId: 'principal:player', action: { actionType: 'speak', parameters: { text: 'go' } },
      correlationId: 'recovery',
    }
    try {
      await coordinator.submit({ ...request, idempotencyKey: 'recovery-fail' })
      expect(providerCalls).toBe(0)
      expect(configured.availability.get(address, npcId)).toMatchObject({ state: 'session_lag' })
      preparationFails = false
      await coordinator.submit({ ...request, idempotencyKey: 'recovery-succeed' })
      expect(providerCalls).toBe(1)
      expect(configured.availability.get(address, npcId)).toMatchObject({ state: 'ready', reason: null })
    } finally { close(configured, coordinator) }
  })

  it('retries a participant after a Provider failure and counts the fault against its backoff', async () => {
    const path = database('phase8-provider-failure-recovery.sqlite')
    const compiled = phase8ReflectionWorld()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    const address = compiled.manifest.address
    const actorId = brandId('character:npc', 'CharacterId')
    const state = { fail: true, calls: 0 }
    const fixtureValue = phase8RetryFixture(path, compiled, [retryParticipant(actorId, state)])
    const { configured } = fixtureValue
    const coordinator = new RoundCoordinator({ ...configured, ...fixtureValue })
    const request = {
      principalId: 'principal:player', action: { actionType: 'speak', parameters: { text: 'go' } },
      correlationId: 'provider-recovery',
    }
    try {
      await coordinator.submit({ ...request, idempotencyKey: 'provider-fail' })
      expect(state.calls).toBe(1)
      expect(configured.availability.get(address, actorId)).toMatchObject({ state: 'model_unavailable' })
      expect(configured.providerQuality!.state(address, 'agent:recovering'))
        .toMatchObject({ responseInvalidStreak: 1 })
      state.fail = false
      await coordinator.submit({ ...request, idempotencyKey: 'provider-recover' })
      expect(state.calls).toBe(2)
      expect(configured.availability.get(address, actorId)).toMatchObject({ state: 'ready', reason: null })
      expect(configured.providerQuality!.state(address, 'agent:recovering'))
        .toMatchObject({ responseInvalidStreak: 0 })
    } finally { close(configured, coordinator) }
  })

  it('retries a participant that lost the Model budget race once a later Round has budget', async () => {
    const path = database('phase8-budget-recovery.sqlite')
    const compiled = phase8ReflectionWorld()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    const address = compiled.manifest.address
    const actorId = brandId('character:npc', 'CharacterId')
    const state = { fail: false, calls: 0 }
    const fixtureValue = phase8RetryFixture(path, compiled, [retryParticipant(actorId, state)])
    const { configured } = fixtureValue
    const request = {
      principalId: 'principal:player', action: { actionType: 'speak', parameters: { text: 'go' } },
      correlationId: 'budget-recovery',
    }
    try {
      const exhausted = new RoundCoordinator({ ...configured, ...fixtureValue, modelBudgetTokens: 0 })
      await exhausted.submit({ ...request, idempotencyKey: 'budget-exhausted' })
      expect(state.calls).toBe(0)
      expect(configured.availability.get(address, actorId)).toMatchObject({ state: 'budget_unavailable' })
      exhausted.close()
      const funded = new RoundCoordinator({ ...configured, ...fixtureValue, modelBudgetTokens: 100 })
      await funded.submit({ ...request, idempotencyKey: 'budget-funded' })
      expect(state.calls).toBe(1)
      expect(configured.availability.get(address, actorId)).toMatchObject({ state: 'ready', reason: null })
      funded.close()
    } finally { close(configured) }
  })

  it('degrades ordinary Phase 8 Context failures but propagates integrity failures', async () => {
    const run = async (suffix: string, failure: () => never) => {
      const path = database(`phase8-context-${suffix}.sqlite`)
      const compiled = world()
      const setup = new WorldStore(path)
      new WorldBootstrap(setup).activate(compiled)
      setup.close()
      let calls = 0
      const npc = participant(`agent:${suffix}`, 'agent', 1, provider(() => {
        calls += 1
        return { participantId: `agent:${suffix}`, actions: [] }
      }))
      const configured = options(path, compiled, [npc])
      const sceneDecision = {
        decideFromEvents: (_address: unknown, player: typeof npc.actorId, _events: unknown, asOfSeq: number) => ({
          sceneId: 'scene:test', observerIds: [player, npc.actorId], schedulableCharacterIds: [npc.actorId],
          visibleResultCharacterIds: [player, npc.actorId], asOfSeq,
        }),
      } as never
      const coordinator = new RoundCoordinator({
        ...configured, sceneDecision, contextPipeline: { prepare: failure } as never,
      })
      const promise = coordinator.submit({
        idempotencyKey: `phase8-${suffix}`, principalId: 'principal:player',
        action: { actionType: 'speak', parameters: { text: suffix } }, correlationId: `phase8-${suffix}`,
      })
      return { promise, calls: () => calls, configured, coordinator }
    }
    const ordinary = await run('ordinary', () => { throw new Error('context offline') })
    await expect(ordinary.promise).resolves.toMatchObject({ status: 'accepted' })
    expect(ordinary.calls()).toBe(0)
    expect(ordinary.configured.availability.get(world().manifest.address, brandId('character:npc', 'CharacterId')))
      .toMatchObject({ state: 'session_lag' })
    close(ordinary.configured, ordinary.coordinator)

    const integrity = await run('integrity', () => failWorld({
      errorCode: 'CONTEXT_REBUILD_DIVERGED', category: 'integrity', message: 'diverged', retryable: false,
      correlationId: 'phase8-integrity',
    }))
    await expect(integrity.promise).rejects.toThrow('diverged')
    expect(integrity.calls()).toBe(0)
    close(integrity.configured, integrity.coordinator)
  })

  it('completes a committed Inbox item without recalling a non-deterministic participant', async () => {
    const path = database('committed-recovery.sqlite')
    const compiled = world()
    const bootstrap = new WorldStore(path)
    new WorldBootstrap(bootstrap).activate(compiled)
    bootstrap.close()
    let providerCalls = 0
    const nonDeterministic = participant('agent:variable', 'agent', 1, provider(() => {
      providerCalls += 1
      return actionProposal('agent:variable', `action:variable:${providerCalls}`, 'speak', { text: `variant ${providerCalls}` })
    }))
    const request = {
      idempotencyKey: 'round:committed-recovery',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'survive commit window' } },
      correlationId: 'committed-recovery',
    } as const
    const interruptedOptions = options(path, compiled, [nonDeterministic], 10, {
      faultInjector: new ThrowAfterCommitOnce(),
    })
    const interrupted = new RoundCoordinator(interruptedOptions)
    await expect(interrupted.submit(request)).rejects.toThrow('after committed coordinated Round')
    expect(providerCalls).toBe(1)
    expect(interruptedOptions.store.head(compiled.manifest.address).tick).toBe(1)
    close(interruptedOptions, interrupted)

    const recoveredOptions = options(path, compiled, [nonDeterministic], 10)
    const recovered = new RoundCoordinator(recoveredOptions)
    const result = await recovered.submit(request)
    expect(result).toMatchObject({ status: 'accepted', tick: 1 })
    expect(providerCalls).toBe(1)
    expect(recoveredOptions.inbox.readCompleted(compiled.manifest.address, request.idempotencyKey)).toEqual(result)
    const audit = new DatabaseSync(path)
    expect((audit.prepare(`SELECT COUNT(*) AS count FROM branch_audit_events WHERE operation = 'round.committed'`)
      .get() as { count: number }).count).toBe(1)
    audit.close()
    close(recoveredOptions, recovered)
  })

  it('reconciles the durable availability transition after a post-commit crash', async () => {
    const path = database('availability-reconciliation.sqlite')
    const compiled = world()
    const bootstrap = new WorldStore(path)
    new WorldBootstrap(bootstrap).activate(compiled)
    bootstrap.close()
    let providerCalls = 0
    let now = 100
    const failingParticipant = participant('agent:availability', 'agent', 1, provider(() => {
      providerCalls += 1
      throw new Error('provider unavailable')
    }))
    const request = {
      idempotencyKey: 'round:availability-reconciliation',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'survive availability window' } },
      correlationId: 'availability-reconciliation',
    } as const
    const interruptedOptions = options(path, compiled, [failingParticipant], 10, {
      faultInjector: new ThrowAfterCommitOnce(), now: () => now,
    })
    const interrupted = new RoundCoordinator(interruptedOptions)
    await expect(interrupted.submit(request)).rejects.toThrow('after committed coordinated Round')
    expect(interruptedOptions.availability.get(compiled.manifest.address, failingParticipant.actorId))
      .toMatchObject({ state: 'ready' })
    const transactionId = interruptedOptions.store.readEvents(compiled.manifest.address)
      .find(event => event.eventType === 'round.participant-terminal')!.transactionId
    close(interruptedOptions, interrupted)

    now = 200
    const recoveredOptions = options(path, compiled, [failingParticipant], 10, { now: () => now })
    const recovered = new RoundCoordinator(recoveredOptions)
    await expect(recovered.submit(request)).resolves.toMatchObject({ status: 'accepted', tick: 1 })
    expect(providerCalls).toBe(1)
    expect(recoveredOptions.availability.get(compiled.manifest.address, failingParticipant.actorId))
      .toMatchObject({ state: 'model_unavailable', reason: 'provider failed', changedAtMs: 200 })
    now = 300
    recovered.reconcileCommittedAvailability(transactionId)
    expect(recoveredOptions.availability.get(compiled.manifest.address, failingParticipant.actorId))
      .toMatchObject({ state: 'model_unavailable', changedAtMs: 200 })
    close(recoveredOptions, recovered)
  })

  it('rejects malformed post-commit availability reconciliation intent', async () => {
    const path = database('availability-reconciliation-invalid.sqlite')
    const compiled = world()
    const bootstrap = new WorldStore(path)
    new WorldBootstrap(bootstrap).activate(compiled)
    bootstrap.close()
    const failingParticipant = participant('agent:availability-invalid', 'agent', 1, provider(() => {
      throw new Error('provider unavailable')
    }))
    const configured = options(path, compiled, [failingParticipant])
    const coordinator = new RoundCoordinator(configured)
    await coordinator.submit({
      idempotencyKey: 'round:availability-invalid', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'persist reconciliation intent' } },
      correlationId: 'availability-invalid',
    })
    const transactionId = configured.store.readEvents(compiled.manifest.address)
      .find(event => event.eventType === 'round.participant-terminal')!.transactionId
    const raw = new DatabaseSync(path)
    const row = raw.prepare(`
      SELECT audit_seq, details_json FROM branch_audit_events
      WHERE operation = 'round.committed' AND details_json LIKE ?
    `).get(`%${transactionId}%`) as { audit_seq: number; details_json: string }
    const original = JSON.parse(row.details_json) as Record<string, unknown>
    const transitions = original.participantAvailability as Array<Record<string, unknown>>
    const valid = transitions[0]!
    const variants: unknown[] = [
      { ...original, participantAvailability: 'invalid' },
      { ...original, participantAvailability: [null] },
      { ...original, participantAvailability: [{ ...valid, participantId: 1 }] },
      { ...original, participantAvailability: [{ ...valid, actorId: 1 }] },
      { ...original, participantAvailability: [{ ...valid, terminalStatus: 1 }] },
      { ...original, participantAvailability: [{ ...valid, state: 1 }] },
      { ...original, participantAvailability: [{ ...valid, reason: 1 }] },
      { ...original, participantAvailability: [valid, valid] },
      { ...original, participantAvailability: [{ ...valid, terminalStatus: 'unknown' }] },
      { ...original, participantAvailability: [{ ...valid, state: 'offline' }] },
      { ...original, participantAvailability: [{ ...valid, reason: null }] },
      { ...original, participantAvailability: [{ ...valid, participantId: 'agent:other' }] },
    ]
    for (const variant of variants) {
      raw.prepare('UPDATE branch_audit_events SET details_json = ? WHERE audit_seq = ?')
        .run(JSON.stringify(variant), row.audit_seq)
      expect(() => coordinator.reconcileCommittedAvailability(transactionId)).toThrow('reconciliation intent')
    }
    raw.prepare('UPDATE branch_audit_events SET details_json = ? WHERE audit_seq = ?')
      .run(row.details_json, row.audit_seq)
    raw.close()
    close(configured, coordinator)
  })

  it('fails closed when availability reconciliation has no valid Authority participant set', () => {
    const path = database('availability-reconciliation-authority-invalid.sqlite')
    const compiled = world()
    const bootstrap = new WorldStore(path)
    new WorldBootstrap(bootstrap).activate(compiled)
    bootstrap.close()
    const configured = options(path, compiled, [])
    const coordinator = new RoundCoordinator(configured)
    const transactionId = brandId('transaction:authority-invalid', 'TransactionId')
    Object.defineProperty(configured.store, 'committedRoundOperationalSummary', {
      value: () => ({
        schemaVersion: 'round-operational-summary/v1',
        participantAvailability: [],
      }),
    })
    let authority: unknown
    Object.defineProperty(configured.store, 'readRoundAuthority', {
      value: () => authority,
    })
    expect(() => coordinator.reconcileCommittedAvailability(transactionId)).toThrow('reconciliation intent')
    authority = { authority: { participants: [null] } }
    expect(() => coordinator.reconcileCommittedAvailability(transactionId)).toThrow('reconciliation intent')
    close(configured, coordinator)
  })

  it('renews the Writer Lease across cumulative participant latency and rejects unsafe timeout configuration', async () => {
    const path = database('lease-renewal.sqlite')
    const compiled = world()
    let now = 1_000
    const bootstrap = new WorldStore(path, undefined, () => now)
    new WorldBootstrap(bootstrap).activate(compiled)
    bootstrap.close()
    const delayed = (participantId: string) => ({
      ...participant(participantId, 'agent', 1, provider(() => {
        now += 300
        return actionProposal(participantId, `action:${participantId}`, 'speak', { text: participantId })
      })),
      timeoutMs: 400,
    })
    const participants = [
      delayed('agent:slow-a'), delayed('agent:slow-b'), delayed('agent:slow-c'), delayed('agent:slow-d'),
    ]
    const unsafeOptions = options(path, compiled, participants, 10, { now: () => now, leaseTtlMs: 500 })
    expect(() => new RoundCoordinator(unsafeOptions)).toThrow('renewal margin')
    close(unsafeOptions)

    const safeOptions = options(path, compiled, participants, 10, { now: () => now, leaseTtlMs: 1_000 })
    const coordinator = new RoundCoordinator(safeOptions)
    await expect(coordinator.submit({
      idempotencyKey: 'round:lease-renewal',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'renew' } },
      correlationId: 'lease-renewal',
    })).resolves.toMatchObject({ status: 'accepted', tick: 1 })
    expect(now).toBe(2_200)
    close(safeOptions, coordinator)
  })

  it.each([
    ['round_id', 'unexpected roundId'],
    ['missing_player', 'no unique player Resolution'],
    ['invalid_result', 'invalid durable shape'],
    ['invalid_reason', 'invalid durable shape'],
  ] as const)('fails closed when committed recovery has %s corruption', async (mutation, message) => {
    const path = database(`malformed-${mutation}.sqlite`)
    const compiled = world()
    const bootstrap = new WorldStore(path)
    new WorldBootstrap(bootstrap).activate(compiled)
    bootstrap.close()
    const request = await installCommittedRecoveryFixture(path, compiled, mutation, mutation)
    const recoveryOptions = options(path, compiled)
    const coordinator = new RoundCoordinator(recoveryOptions)
    await expect(coordinator.submit(request)).rejects.toThrow(message)
    close(recoveryOptions, coordinator)
  })

  it('restores a durable rejected player result without recomputing the Round', async () => {
    const path = database('committed-rejected.sqlite')
    const compiled = world()
    const bootstrap = new WorldStore(path)
    new WorldBootstrap(bootstrap).activate(compiled)
    bootstrap.close()
    const request = await installCommittedRecoveryFixture(path, compiled, 'rejected', 'rejected')
    const recoveryOptions = options(path, compiled)
    const coordinator = new RoundCoordinator(recoveryOptions)
    await expect(coordinator.submit(request)).resolves.toMatchObject({ status: 'rejected', reason: 'denied', tick: 1 })
    close(recoveryOptions, coordinator)
  })

  it('fails closed at construction, admission, durable input, and unexpected validator boundaries', async () => {
    const compiled = world()
    const missingPath = database('missing.sqlite')
    const missing = options(missingPath, compiled)
    expect(() => new RoundCoordinator(missing)).toThrow('not active')
    close(missing)

    const path = database('fail-closed.sqlite')
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    const mismatch = options(path, { ...compiled, manifestHash: hashWorldJson('wrong', 1) })
    expect(() => new RoundCoordinator(mismatch)).toThrow('not active')
    close(mismatch)

    const duplicate = participant('participant:same', 'agent', 1, provider(() => actionProposal('participant:same', 'a', 'speak', { text: 'a' })))
    const duplicateOptions = options(path, compiled, [duplicate, duplicate])
    expect(() => new RoundCoordinator(duplicateOptions)).toThrow('unique')
    close(duplicateOptions)

    const invalidLeaseOptions = options(path, compiled, [], 100, { leaseTtlMs: 0 })
    expect(() => new RoundCoordinator(invalidLeaseOptions)).toThrow('positive safe integer')
    close(invalidLeaseOptions)

    const missingSceneOptions = options(path, compiled)
    expect(() => new RoundCoordinator({
      ...missingSceneOptions,
      cognitiveMemory: {} as never,
    })).toThrow('requires an authoritative Scene decision service')
    close(missingSceneOptions)

    const unknown = { ...duplicate, participantId: 'participant:unknown', actorId: brandId('character:missing', 'CharacterId') }
    const unknownOptions = options(path, compiled, [unknown])
    expect(() => new RoundCoordinator(unknownOptions)).toThrow('manifest')
    close(unknownOptions)

    const normalOptions = options(path, compiled)
    const normal = new RoundCoordinator(normalOptions)
    normal.reconcileCommittedProviderCalls(brandId('transaction:absent', 'TransactionId'))
    expect(() => normal.submit({
      idempotencyKey: '', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: {} }, correlationId: 'invalid',
    })).toThrow(TypeError)
    expect(() => normal.submit({
      idempotencyKey: 'unauthorized', principalId: 'principal:other',
      action: { actionType: 'speak', parameters: {} }, correlationId: 'unauthorized',
    })).toThrow('no PlayerBinding')
    expect(() => normal.submit({
      idempotencyKey: 'shape', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: {}, extra: true } as never, correlationId: 'shape',
    })).toThrow('exactly')
    normal.close()
    normal.close()
    expect(() => normal.accept({
      idempotencyKey: 'closed-accept', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: {} }, correlationId: 'closed-accept',
    })).toThrow('closed')
    await expect(normal.submit({
      idempotencyKey: 'closed', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: {} }, correlationId: 'closed',
    })).rejects.toThrow('closed')
    await expect(normal.processNextAccepted('closed-next')).rejects.toThrow('closed')
    await expect(normal.processNextAcceptedStep('closed-step')).rejects.toThrow('closed')
    close(normalOptions)

    const requiredPath = database('required-next.sqlite')
    const requiredSetup = new WorldStore(requiredPath)
    new WorldBootstrap(requiredSetup).activate(compiled)
    requiredSetup.close()
    const requiredOptions = options(requiredPath, compiled)
    const required = new RoundCoordinator(requiredOptions)
    required.accept({
      idempotencyKey: 'required-next', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'required' } }, correlationId: 'required-next',
    })
    const requiredRaw = new DatabaseSync(requiredPath)
    requiredRaw.prepare(`DELETE FROM round_inbox WHERE idempotency_key = 'required-next'`).run()
    requiredRaw.close()
    await expect(required.processNextAccepted('required-next')).rejects.toThrow('lost an admitted responsive/v1 item')
    close(requiredOptions, required)

    const corruptOptions = options(path, compiled)
    corruptOptions.inbox.enqueue({
      address: compiled.manifest.address,
      idempotencyKey: 'corrupt',
      principalId: 'principal:player',
      input: { invalid: true },
      correlationId: 'corrupt',
    }, 8)
    const corrupt = new RoundCoordinator(corruptOptions)
    await expect(corrupt.submit({
      idempotencyKey: 'after-corrupt', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'later' } }, correlationId: 'after-corrupt',
    })).rejects.toThrow('invalid shape')
    close(corruptOptions, corrupt)

    const hostilePath = database('hostile.sqlite')
    const hostileSetup = new WorldStore(hostilePath)
    new WorldBootstrap(hostileSetup).activate(compiled)
    hostileSetup.close()
    const hostile = new Proxy({ participantId: 'participant:hostile', actions: [] }, {
      get() { throw new Error('hostile reflection') },
    }) as Proposal
    const hostileOptions = options(hostilePath, compiled, [
      participant('participant:hostile', 'agent', 1, provider(() => hostile)),
    ])
    const hostileCoordinator = new RoundCoordinator(hostileOptions)
    await expect(hostileCoordinator.submit({
      idempotencyKey: 'hostile', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'hostile' } }, correlationId: 'hostile',
    })).resolves.toMatchObject({ status: 'accepted' })
    expect(hostileOptions.store.readEvents(compiled.manifest.address)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'round.participant-terminal', data: expect.objectContaining({ status: 'provider_failed' }) }),
    ]))
    close(hostileOptions, hostileCoordinator)

    const fifoPath = database('fifo.sqlite')
    const fifoSetup = new WorldStore(fifoPath)
    new WorldBootstrap(fifoSetup).activate(compiled)
    fifoSetup.close()
    const fifoOptions = options(fifoPath, compiled)
    fifoOptions.inbox.enqueue({
      address: compiled.manifest.address, idempotencyKey: 'prior', principalId: 'principal:player',
      input: { actionType: 'speak', parameters: { text: 'prior' } }, correlationId: 'prior',
    }, 8)
    const fifo = new RoundCoordinator(fifoOptions)
    expect(await fifo.submit({
      idempotencyKey: 'target', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'target' } }, correlationId: 'target',
    })).toMatchObject({ tick: 2 })
    close(fifoOptions, fifo)

    const lostPath = database('lost.sqlite')
    const lostSetup = new WorldStore(lostPath)
    new WorldBootstrap(lostSetup).activate(compiled)
    lostSetup.close()
    const lostOptions = options(lostPath, compiled)
    const lost = new RoundCoordinator(lostOptions)
    const lostPromise = lost.submit({
      idempotencyKey: 'lost', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'lost' } }, correlationId: 'lost',
    })
    const lostRaw = new DatabaseSync(lostPath)
    lostRaw.prepare(`DELETE FROM round_inbox WHERE idempotency_key = 'lost'`).run()
    lostRaw.close()
    await expect(lostPromise).rejects.toThrow('lost admitted item')
    close(lostOptions, lost)

    const bindingPath = database('binding.sqlite')
    const bindingSetup = new WorldStore(bindingPath)
    new WorldBootstrap(bindingSetup).activate(compiled)
    bindingSetup.close()
    const bindingOptions = options(bindingPath, compiled)
    bindingOptions.inbox.enqueue({
      address: compiled.manifest.address, idempotencyKey: 'deleted-binding', principalId: 'principal:deleted',
      input: { actionType: 'speak', parameters: { text: 'deleted' } }, correlationId: 'deleted-binding',
    }, 8)
    const bindingCoordinator = new RoundCoordinator(bindingOptions)
    await expect(bindingCoordinator.submit({
      idempotencyKey: 'after-deleted', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'after' } }, correlationId: 'after-deleted',
    })).rejects.toThrow('lost its PlayerBinding')
    close(bindingOptions, bindingCoordinator)
  })

  it('delivers a private player stimulus only to its recipient and records exclusions for bystanders and Director', async () => {
    const worldPath = database('phase8-private-stimulus-world.sqlite')
    const sessionPath = `${worldPath}.session.sqlite`
    const memoryPath = `${worldPath}.memory.sqlite`
    const compiled = phase8ReflectionWorld()
    const received = new Map<string, ProposalContext>()
    const participantFor = (
      participantId: string,
      role: 'agent' | 'director',
      actorId: 'character:player' | 'character:npc' | 'character:witness',
    ): RoundParticipant => ({
      participantId,
      role,
      actorId: brandId(actorId, 'CharacterId'),
      allowedActionTypes: role === 'agent' ? ['speak'] : ['take_initiative'],
      priority: 1,
      estimatedTokens: 1,
      timeoutMs: 100,
      provider: {
        async propose(context) {
          received.set(participantId, context)
          return role === 'agent'
            ? { schemaVersion: 2 as const, decision: 'abstain' as const, actions: [] }
            : { participantId, actions: [] }
        },
      },
    })
    const application = new WorldApplication({
      worldPath,
      sessionPath,
      memoryPath,
      modelBudgetTokens: 10,
      participants: () => [
        participantFor('agent:recipient', 'agent', 'character:npc'),
        participantFor('agent:bystander', 'agent', 'character:witness'),
        participantFor('director:scene', 'director', 'character:player'),
      ],
    })
    application.activate(compiled)
    await application.submit(compiled.manifest.address, {
      idempotencyKey: 'private-stimulus:1',
      principalId: 'principal:player',
      action: {
        actionType: 'speak',
        parameters: {
          text: 'PRIVATE_CANARY_ONLY_FOR_NPC',
          scope: 'private',
          addresseeIds: ['character:npc'],
        },
      },
      correlationId: 'private-stimulus:1',
    })
    expect([...received.keys()].sort()).toEqual(['agent:bystander', 'agent:recipient', 'director:scene'])
    const recipient = received.get('agent:recipient') as Phase8ProviderContext
    const bystander = received.get('agent:bystander') as Phase8ProviderContext
    const director = received.get('director:scene') as Phase8ProviderContext
    expect(JSON.stringify(recipient)).toContain('PRIVATE_CANARY_ONLY_FOR_NPC')
    expect(bystander.playerAction).toMatchObject({
      actionType: 'private_interaction',
      parameters: { status: 'accepted', contentVisibility: 'occurrence_only' },
    })
    expect(director.playerAction).toMatchObject({
      actionType: 'context.no-visible-stimulus',
      parameters: { visibility: 'none' },
    })
    expect(JSON.stringify(bystander)).not.toContain('PRIVATE_CANARY_ONLY_FOR_NPC')
    expect(JSON.stringify(director)).not.toContain('PRIVATE_CANARY_ONLY_FOR_NPC')
    expect(new Set([recipient.candidateHash, bystander.candidateHash, director.candidateHash]).size).toBe(3)
    await application.close()

    const receipts = new ContextReceiptStore(`${memoryPath}.context.sqlite`)
    expect(receipts.read(recipient.contextReceiptId)?.exclusions).not.toContainEqual(expect.objectContaining({
      reason: 'audience_forbidden',
    }))
    for (const hidden of [bystander, director]) {
      expect(receipts.read(hidden.contextReceiptId)?.exclusions).toContainEqual(expect.objectContaining({
        reason: 'audience_forbidden',
      }))
    }
    receipts.close()
  })

  it('does not dispatch a Scene v2 Director when the focal Scene is ineligible', async () => {
    const path = database('phase8-director-ineligible.sqlite')
    const compiled = phase8SceneWorld()
    const setup = new WorldStore(path)
    new WorldBootstrap(setup).activate(compiled)
    setup.close()
    let directorCalls = 0
    const director: RoundParticipant = {
      participantId: 'director:ineligible',
      role: 'director',
      actorId: brandId('character:player', 'CharacterId'),
      allowedActionTypes: ['take_initiative'],
      priority: 1,
      estimatedTokens: 1,
      timeoutMs: 100,
      provider: {
        async propose() {
          directorCalls += 1
          return { participantId: 'director:ineligible', actions: [] }
        },
      },
    }
    const configured = options(path, compiled, [director])
    const coordinator = new RoundCoordinator({
      ...configured,
      sceneDecision: {
        version: 2,
        decideFromEvents: (_address: unknown, _player: unknown, _events: unknown, asOfSeq: number) => ({
          schemaVersion: 'scene-decision/v2',
          sceneId: null,
          memberIds: [],
          observerIds: [],
          schedulableCharacterIds: [],
          visibleResultCharacterIds: [],
          directorEligible: false,
          asOfSeq,
          decisionHash: hashWorldJson('scene-decision/v2', {
            schemaVersion: 'scene-decision/v2', sceneId: null, memberIds: [], observerIds: [],
            schedulableCharacterIds: [], visibleResultCharacterIds: [], directorEligible: false, asOfSeq,
          }),
        }),
        audienceForAction: () => ({ fullContentCharacterIds: [], occurrenceOnlyCharacterIds: [] }),
      } as never,
    })
    await expect(coordinator.submit({
      idempotencyKey: 'director-ineligible:1',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'No active Scene' } },
      correlationId: 'director-ineligible:1',
    })).resolves.toMatchObject({ status: 'accepted' })
    expect(directorCalls).toBe(0)
    expect(configured.store.readEvents(compiled.manifest.address).filter(event =>
      event.eventType === 'round.participant-terminal')).toEqual([])
    close(configured, coordinator)
  })
})
