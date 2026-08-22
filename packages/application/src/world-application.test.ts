import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type AgentProvider,
  type ProposalContext,
  type WorldAddress,
} from '@harness-world/contracts'
import { WorldSpecCompiler } from '@harness-world/kernel'
import { SessionDeliveryAdapter, SessionOutboxWorker, WorldOutbox } from '@harness-world/store-sqlite'
import { WorldApplication, type WorldApplicationOptions } from './world-application.ts'
import type { RoundParticipant } from './round-coordinator.ts'

const directories: string[] = []

function paths(): { worldPath: string; sessionPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-world-application-'))
  directories.push(directory)
  return { worldPath: join(directory, 'world.sqlite'), sessionPath: join(directory, 'session.sqlite') }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function compiled() {
  return new WorldSpecCompiler().compile({
    schemaVersion: 1,
    address: { tenantId: 'tenant:application', worldId: 'world:application', branchId: 'branch:main' },
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

function participants(calls: { value: number }): (address: WorldAddress) => readonly RoundParticipant[] {
  const provider = (participantId: string, text: string): AgentProvider => ({
    async propose(context: ProposalContext) {
      calls.value += 1
      return {
        participantId,
        actions: [{
          actionId: `${participantId}:${context.roundId}`,
          actorId: brandId('character:npc', 'CharacterId'),
          actionType: 'speak',
          actionVersion: 1,
          parameters: { text },
        }],
      }
    },
  })
  return () => [
    {
      participantId: 'agent:npc', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
      provider: provider('agent:npc', 'agent response'),
    },
    {
      participantId: 'director:scene', role: 'director', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
      provider: provider('director:scene', 'director response'),
    },
  ]
}

function request(idempotencyKey: string, text = idempotencyKey) {
  return {
    idempotencyKey,
    principalId: 'principal:player',
    action: { actionType: 'speak', parameters: { text } },
    correlationId: idempotencyKey,
  } as const
}

describe('WorldApplication', () => {
  it('runs the real Cordis composition through Round, View, Session, fork, archive, and restart', async () => {
    const persistence = paths()
    const world = compiled()
    const calls = { value: 0 }
    const options: WorldApplicationOptions = {
      ...persistence,
      participants: participants(calls),
      modelBudgetTokens: 10,
    }
    const app = new WorldApplication(options)
    expect(app.activate(world)).toMatchObject({ status: 'activated' })
    expect(app.activate(world)).toMatchObject({ status: 'already_active' })
    expect(await app.roundResult(world.manifest.address, 'missing')).toBeUndefined()
    const parentResult = await app.submit(world.manifest.address, request('parent-round', 'hello world'))
    expect(parentResult).toMatchObject({ status: 'accepted', tick: 1 })
    expect(calls.value).toBe(2)
    expect(await app.submit(world.manifest.address, request('parent-round', 'hello world'))).toEqual(parentResult)
    expect(calls.value).toBe(2)
    expect(await app.roundResult(world.manifest.address, 'parent-round')).toEqual(parentResult)
    const parentHead = await app.head(world.manifest.address)
    const view = await app.characterView(world.manifest.address, brandId('character:player', 'CharacterId'))
    expect(view.asOfWorldSeq).toBe(parentHead.headSeq)
    expect(view.observations).toHaveLength(3)
    expect((await app.characterView(
      world.manifest.address,
      brandId('character:player', 'CharacterId'),
      parentHead.headSeq,
    )).bundleHash).toBe(view.bundleHash)
    expect(await app.deliver(world.manifest.address, 'deliver:parent')).toBe(3)
    const presentation = await app.renderSession(
      world.manifest.address,
      brandId('session:player', 'SessionId'),
      1,
      { locale: 'zh-CN' },
    )
    expect(presentation).toMatchObject({ locale: 'zh-CN', rendererProfileVersion: 1 })
    await expect(app.renderSession(
      world.manifest.address,
      brandId('session:player', 'SessionId'),
      99,
    )).rejects.toThrow('missing')

    const child = { ...world.manifest.address, branchId: brandId('branch:child', 'BranchId') }
    const forked = await app.forkAtHead(world.manifest.address, child, 'checkpoint', 'application:fork')
    expect(forked).toMatchObject({ forkSeq: parentHead.headSeq, parentState: { admissionState: 'open' } })
    const parentBeforeChild = await app.head(world.manifest.address)
    const childResult = await app.submit(child, request('child-round'))
    expect(childResult.tick).toBe(2)
    expect((await app.head(world.manifest.address)).headSeq).toBe(parentBeforeChild.headSeq)
    expect(await app.deliver(child, 'deliver:child')).toBe(3)
    expect(app.activeBranchCount).toBe(2)

    const archived = await app.archive(world.manifest.address, 'parent complete', 'application:archive')
    expect(archived).toMatchObject({ state: { lifecycleState: 'archived' }, drainedRounds: 0, drainedDeliveries: 0 })
    expect(app.activeBranchCount).toBe(1)
    const afterArchive = await app.submit(child, request('child-after-parent-archive'))
    expect(afterArchive.tick).toBe(3)
    expect(calls.value).toBe(6)
    await app.release(child)
    await app.release(child)
    expect(app.activeBranchCount).toBe(0)
    await app.close()
    await app.close()
    expect(() => app.activate(world)).toThrow('closed')
    await expect(app.submit(child, request('closed'))).rejects.toThrow('closed')

    const restarted = new WorldApplication(options)
    expect(await restarted.roundResult(child, 'child-after-parent-archive')).toEqual(afterArchive)
    expect(await restarted.submit(child, request('child-after-parent-archive'))).toEqual(afterArchive)
    expect(calls.value).toBe(6)
    expect((await restarted.renderSession(child, brandId('session:player', 'SessionId'), 1)).presentationHash)
      .toBeTruthy()
    await restarted.close()
  })

  it('contains mount, component, delivery, and concurrent-close failures without retaining slots', async () => {
    const persistence = paths()
    const world = compiled()
    const app = new WorldApplication(persistence)
    app.activate(world)
    const missing = { ...world.manifest.address, branchId: brandId('branch:missing', 'BranchId') }
    await expect(app.head(missing)).rejects.toThrow('no active Compiled Manifest')
    expect(app.activeBranchCount).toBe(0)

    const incompatible = new WorldApplication(persistence)
    incompatible.activate(world)
    const dispose = vi.fn(async () => undefined)
    vi.spyOn(incompatible.runtimeRegistry, 'acquire').mockResolvedValueOnce({
      fencingToken: 1,
      dispose,
      slot: { components: { kernel: {}, store: {}, agents: {}, director: {} } },
    } as never)
    await expect(incompatible.head(world.manifest.address)).rejects.toThrow('incompatible component set')
    expect(dispose).toHaveBeenCalledOnce()
    await incompatible.close()

    const invalidActor = new WorldApplication({
      ...persistence,
      modelBudgetTokens: 1,
      leaseTtlMs: 1_000,
      participants: () => [{
        participantId: 'agent:invalid', role: 'agent', actorId: brandId('character:missing', 'CharacterId'),
        allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
        provider: { propose: async () => ({ participantId: 'agent:invalid', actions: [] }) },
      }],
    })
    await expect(invalidActor.head(world.manifest.address)).rejects.toThrow('must exist in the manifest')
    expect(invalidActor.activeBranchCount).toBe(0)
    await invalidActor.close()

    const missingBudget = new WorldApplication({
      ...persistence,
      participants: () => [{
        participantId: 'agent:budget', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
        allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
        provider: { propose: async () => ({ participantId: 'agent:budget', actions: [] }) },
      }],
    })
    await expect(missingBudget.head(world.manifest.address)).rejects.toThrow('modelBudgetTokens must be configured')
    expect(missingBudget.activeBranchCount).toBe(0)
    await missingBudget.close()

    const divergent = new WorldApplication({ ...persistence, outboxMaxAttempts: 2 })
    divergent.activate(world)
    await divergent.submit(world.manifest.address, request('delivery-divergence'))
    const occupied = new SessionDeliveryAdapter(persistence.sessionPath)
    await occupied.appendIfAbsent({
      sessionId: brandId('session:player', 'SessionId'),
      sessionDeliverySeq: 1,
      deliveryId: brandId('delivery:occupied', 'DeliveryId'),
      payloadHash: hashWorldJson('occupied', 1),
      observationEvent: { occupied: true },
      correlationId: 'occupied',
    })
    occupied.close()
    await expect(divergent.deliver(world.manifest.address, 'delivery:divergent')).rejects.toThrow('different content')
    await divergent.close()

    const retryPersistence = paths()
    const retryable = new WorldApplication({ ...retryPersistence, outboxMaxAttempts: 2 })
    retryable.activate(world)
    await retryable.submit(world.manifest.address, request('delivery-retryable'))
    const retrySession = new SessionDeliveryAdapter(retryPersistence.sessionPath)
    retrySession.close()
    const retryRaw = new DatabaseSync(retryPersistence.sessionPath)
    retryRaw.prepare(`INSERT INTO session_delivery_cursor(session_id, last_delivery_seq) VALUES (?, 2)`)
      .run('session:player')
    retryRaw.close()
    await expect(retryable.deliver(world.manifest.address, 'delivery:retryable')).rejects.toThrow('retry_scheduled')
    await retryable.close()

    const writerPersistence = paths()
    const firstWriter = new WorldApplication({ ...writerPersistence, runtimeOwnerId: 'shared-label' })
    const secondWriter = new WorldApplication({ ...writerPersistence, runtimeOwnerId: 'shared-label' })
    firstWriter.activate(world)
    expect(await firstWriter.head(world.manifest.address)).toMatchObject({ tick: expect.any(Number) })
    await expect(secondWriter.head(world.manifest.address)).rejects.toThrow('another writer owns')
    await firstWriter.close()
    await secondWriter.close()

    expect(() => new WorldApplication({ ...persistence, runtimeOwnerId: '' })).toThrow('diagnostic label')

    const closing = new WorldApplication(paths())
    const pending = closing.head(world.manifest.address)
    await closing.close()
    await expect(pending).rejects.toThrow('no active Compiled Manifest')
    expect(closing.activeBranchCount).toBe(0)
  })

  it('recovers a critical dead letter through the Application Port before archiving', async () => {
    const persistence = paths()
    const world = compiled()
    const app = new WorldApplication({ ...persistence, outboxMaxAttempts: 1 })
    app.activate(world)
    await app.submit(world.manifest.address, request('dead-letter-round'))
    await app.release(world.manifest.address)

    const outbox = new WorldOutbox(persistence.worldPath)
    const failed = new SessionOutboxWorker(outbox, {
      appendIfAbsent: async () => { throw new Error('temporary Session outage') },
    }, world.manifest.address, 1)
    await expect(failed.runOnce('dead-letter:fixture')).resolves.toMatchObject({ status: 'dead_letter' })
    outbox.close()

    await expect(app.deadLetters(world.manifest.address)).resolves.toMatchObject([{
      critical: true, lastError: 'temporary Session outage',
    }])
    await expect(app.archive(world.manifest.address, 'blocked', 'archive:blocked')).rejects.toThrow('critical delivery')
    expect(app.activeBranchCount).toBe(0)

    const [deadLetter] = await app.deadLetters(world.manifest.address)
    if (deadLetter === undefined) throw new Error('dead-letter fixture is missing')
    await app.retryDeadLetter(world.manifest.address, deadLetter.deliveryId, 'dead-letter:retry')
    await expect(app.deliver(world.manifest.address, 'dead-letter:deliver')).resolves.toBe(1)
    await expect(app.archive(world.manifest.address, 'recovered', 'archive:recovered')).resolves.toMatchObject({
      state: { lifecycleState: 'archived' },
    })
    expect(app.activeBranchCount).toBe(0)
    await app.close()
  })
})
