import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  deterministicId,
  hashWorldJson,
  type AgentProvider,
  type FaultInjector,
  type FaultPoint,
  type Proposal,
  type ProposalContext,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  currentEntityState,
  WorldBootstrap,
  WorldSpecCompiler,
  type CompiledWorldSpec,
  type RoundExecutionLane,
} from '@harness-world/kernel'
import { createMysteryRulebookRegistry, inspectionEvidenceId } from '../../simulation/src/mystery-rulebooks.ts'
import { BranchAdministration, CharacterRuntimeAvailabilityService, RoundInbox, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import {
  RoundCoordinator,
  compareActionOrderKey,
  parseClaimedPlayerAction,
  type ActionOrderKey,
  type RoundCoordinatorOptions,
  type RoundParticipant,
} from './round-coordinator.ts'

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

function investigationWorld(version: 2 | 4 = 2): CompiledWorldSpec {
  return new WorldSpecCompiler().compile({
    schemaVersion: 2,
    address: { tenantId: 'tenant:coordinator', worldId: `world:competition-v${version}`, branchId: 'branch:main' },
    metadata: { title: 'Take competition', description: '' },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 8,
    runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
    rulebook: { rulebookId: 'builtin:speak-move', version },
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
): RoundCoordinatorOptions & { store: WorldStore; inbox: RoundInbox; leases: WriterLeaseService; availability: CharacterRuntimeAvailabilityService } {
  const now = configuration.now ?? Date.now
  const store = new WorldStore(path, configuration.faultInjector, now)
  const inbox = new RoundInbox(path, now)
  const leases = new WriterLeaseService(path, now)
  const availability = new CharacterRuntimeAvailabilityService(path, now)
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
    ...(configuration.leaseTtlMs === undefined ? {} : { leaseTtlMs: configuration.leaseTtlMs }),
  }
}

function close(optionsValue: ReturnType<typeof options>, coordinator?: RoundCoordinator): void {
  coordinator?.close()
  optionsValue.inbox.close()
  optionsValue.availability.close()
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
    const compiled = investigationWorld()
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

  it('re-resolves duplicate v4 inspections from one Proposal against the same-Round prefix', async () => {
    const path = database('inspect-competition.sqlite')
    const compiled = investigationWorld(4)
    const bootstrap = new WorldStore(path)
    new WorldBootstrap(bootstrap).activate(compiled)
    bootstrap.close()
    const participant: RoundParticipant = {
      participantId: 'agent:fast', role: 'agent', actorId: brandId('character:fast', 'CharacterId'),
      allowedActionTypes: ['inspect'], priority: 2, estimatedTokens: 1, timeoutMs: 100,
      provider: provider(() => ({
        participantId: 'agent:fast',
        actions: ['first', 'second'].map(value => ({
          actionId: `action:inspect:${value}`,
          actorId: brandId('character:fast', 'CharacterId'),
          actionType: 'inspect', actionVersion: 1, parameters: { entityId: 'entity:key' },
        })),
      })),
    }
    const baseOptions = options(path, compiled, [participant])
    const rulebooks = createMysteryRulebookRegistry()
    const coordinatorOptions = { ...baseOptions, rulebooks }
    const coordinator = new RoundCoordinator(coordinatorOptions)
    await coordinator.submit({
      idempotencyKey: 'round:inspect-competition', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'inspect it' } }, correlationId: 'inspect-competition',
    })
    const events = coordinatorOptions.store.readEvents(compiled.manifest.address)
    expect(events.filter(value => value.eventType === 'entity.inspected')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({
        characterId: 'character:fast', evidenceId: inspectionEvidenceId('entity:key'),
      }) }),
    ])
    expect(events.filter(value => value.eventType === 'action.resolved').map(value => value.data)).toEqual([
      expect.objectContaining({ participantId: 'player', accepted: true, order: 0 }),
      expect.objectContaining({ participantId: 'agent:fast', accepted: true, order: 1 }),
      expect.objectContaining({ participantId: 'agent:fast', accepted: false, reason: 'ALREADY_INSPECTED', order: 2 }),
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

    const unknown = { ...duplicate, participantId: 'participant:unknown', actorId: brandId('character:missing', 'CharacterId') }
    const unknownOptions = options(path, compiled, [unknown])
    expect(() => new RoundCoordinator(unknownOptions)).toThrow('manifest')
    close(unknownOptions)

    const normalOptions = options(path, compiled)
    const normal = new RoundCoordinator(normalOptions)
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
