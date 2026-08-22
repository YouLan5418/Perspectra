import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type AgentProvider,
  type Proposal,
  type ProposalContext,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { WorldBootstrap, WorldSpecCompiler, type CompiledWorldSpec, type RoundExecutionLane } from '@harness-world/kernel'
import { RoundInbox, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import {
  RoundCoordinator,
  compareActionOrderKey,
  parseClaimedPlayerAction,
  type ActionOrderKey,
  type RoundCoordinatorOptions,
  type RoundParticipant,
} from './round-coordinator.ts'

const directories: string[] = []

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
): RoundCoordinatorOptions & { store: WorldStore; inbox: RoundInbox; leases: WriterLeaseService } {
  const store = new WorldStore(path)
  const inbox = new RoundInbox(path)
  const leases = new WriterLeaseService(path)
  return {
    store,
    inbox,
    leases,
    runtimeLane: lane(compiled),
    ownerId: 'coordinator:test',
    participants,
    modelBudgetTokens,
  }
}

function close(optionsValue: ReturnType<typeof options>, coordinator?: RoundCoordinator): void {
  coordinator?.close()
  optionsValue.inbox.close()
  optionsValue.leases.close()
  optionsValue.store.close()
}

describe('RoundCoordinator', () => {
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
    expect(firstOptions.store.readOutbox(compiled.manifest.address)).toHaveLength(3)
    const eventHashes = events.map(value => value.eventHash)
    close(firstOptions, coordinator)

    const restartedOptions = options(path, compiled, participants, 4)
    const restarted = new RoundCoordinator(restartedOptions)
    expect(await restarted.submit(request)).toEqual(result)
    expect(providerCalls).toBe(5)
    expect(restartedOptions.store.readEvents(compiled.manifest.address).map(value => value.eventHash)).toEqual(eventHashes)
    close(restartedOptions, restarted)
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
