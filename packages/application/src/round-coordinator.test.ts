import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createContextReceipt,
  ProviderCallStore,
} from '@harness-world/agents'
import {
  brandId,
  deterministicId,
  failWorld,
  hashWorldJson,
  PHASE8_REGISTRY_LOCKS,
  PHASE8_VOCABULARY_LOCKS,
  type AgentProvider,
  type FaultInjector,
  type FaultPoint,
  type InteractionRoundId,
  type Proposal,
  type ProposalContext,
  type SubmitActionsV2,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  currentEntityState,
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
  type ActionOrderKey,
  type RoundCoordinatorOptions,
  type RoundParticipant,
} from './round-coordinator.ts'
import { SceneDecisionService } from './scene-decision.ts'

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
): RoundCoordinatorOptions & { store: WorldStore; inbox: RoundInbox; leases: WriterLeaseService; availability: CharacterRuntimeAvailabilityService; providerCalls?: ProviderCallStore } {
  const now = configuration.now ?? Date.now
  const store = new WorldStore(path, configuration.faultInjector, now)
  const inbox = new RoundInbox(path, now)
  const leases = new WriterLeaseService(path, now)
  const availability = new CharacterRuntimeAvailabilityService(path, now)
  const providerCalls = compiled.manifest.schemaVersion === 4 ? new ProviderCallStore(`${path}.context.sqlite`) : undefined
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
    ...(configuration.leaseTtlMs === undefined ? {} : { leaseTtlMs: configuration.leaseTtlMs }),
  }
}

function close(optionsValue: ReturnType<typeof options>, coordinator?: RoundCoordinator): void {
  coordinator?.close()
  optionsValue.inbox.close()
  optionsValue.availability.close()
  optionsValue.providerCalls?.close()
  optionsValue.leases.close()
  optionsValue.store.close()
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

  it.each(['prepared_budget', 'dispatch_started', 'response_received', 'validated'] as const)(
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
    const rawResponse = recoveredState === 'validated'
      ? { schemaVersion: 2, decision: 'abstain', actions: [{}] }
      : { schemaVersion: 2, decision: 'abstain', actions: [] }
    if (recoveredState === 'response_received' || recoveredState === 'validated') {
      configured.providerCalls!.recordResponse(prepared.modelCallId, rawResponse, { provider: 'scripted' })
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
        : recoveredState === 'dispatch_started' ? 'timed_out_ambiguous' : 'committed',
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
    } as never)).toThrow('durable Provider call boundary')
    close(configured)
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
    close(normalOptions)

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
})
