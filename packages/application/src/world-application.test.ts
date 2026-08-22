import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  brandId,
  createErrorEnvelope,
  deterministicId,
  hashWorldJson,
  type AgentProvider,
  type ProposalContext,
  type WorldAddress,
} from '@harness-world/contracts'
import { WorldSpecCompiler } from '@harness-world/kernel'
import {
  BranchQuarantineService,
  SessionDeliveryAdapter,
  SessionOutboxWorker,
  WorldOutbox,
  WorldStore,
} from '@harness-world/store-sqlite'
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
  it('mounts and executes an immutable stored V1 Manifest without reactivation', async () => {
    const persistence = paths()
    const address = {
      tenantId: brandId('tenant:legacy', 'TenantId'),
      worldId: brandId('world:legacy', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const manifest = {
      schemaVersion: 1,
      address,
      timeMode: 'TURN_DRIVEN',
      roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:legacy', name: 'Legacy Room' }],
      characters: [{ characterId: 'character:legacy', name: 'Legacy Player', locationId: 'location:legacy' }],
      playerBindings: [{ principalId: 'principal:legacy', characterId: 'character:legacy', sessionId: 'session:legacy' }],
      plugins: [],
    } as const
    const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
    const genesisEvents = [
      { eventType: 'world.activated', eventVersion: 1, data: { manifestHash } },
      { eventType: 'location.upsert', eventVersion: 1, data: manifest.locations[0]! },
      { eventType: 'character.upsert', eventVersion: 1, data: manifest.characters[0]! },
      { eventType: 'player.binding.upsert', eventVersion: 1, data: manifest.playerBindings[0]! },
    ] as const
    const genesisHash = hashWorldJson('world-genesis-plan', genesisEvents)
    const identity = { address, manifestHash, genesisHash }
    const store = new WorldStore(persistence.worldPath)
    store.activateBranch({
      address, manifest, manifestHash, genesisEvents, genesisHash,
      transactionId: brandId(deterministicId('transaction:genesis', identity), 'TransactionId'),
      roundId: brandId(deterministicId('round:genesis', identity), 'InteractionRoundId'),
      correlationId: 'legacy:activation',
    })
    store.close()

    const app = new WorldApplication(persistence)
    expect(await app.head(address)).toMatchObject({ tick: 0 })
    await expect(app.submit(address, {
      idempotencyKey: 'legacy:round', principalId: 'principal:legacy',
      action: { actionType: 'speak', parameters: { text: 'still alive' } }, correlationId: 'legacy:round',
    })).resolves.toMatchObject({ status: 'accepted', tick: 1 })
    await app.close()
  })

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
    const npcId = brandId('character:npc', 'CharacterId')
    expect(await app.characterAvailability(world.manifest.address, npcId)).toMatchObject({ state: 'ready' })
    expect(await app.setCharacterAvailability(world.manifest.address, npcId, 'offline', 'test transition')).toMatchObject({ state: 'offline' })
    expect(await app.setCharacterAvailability(world.manifest.address, npcId, 'ready', null)).toMatchObject({ state: 'ready' })
    const cancelled = await app.acceptRound(world.manifest.address, request('cancel-before-claim', 'cancel me'))
    expect(cancelled).toMatchObject({ status: 'queued', roundId: expect.any(String) })
    expect(await app.roundStatus(world.manifest.address, { roundId: cancelled.roundId })).toMatchObject({ status: 'queued' })
    expect(await app.cancelQueuedRound(world.manifest.address, { roundId: cancelled.roundId }, 'cancel-before-claim')).toMatchObject({ status: 'cancelled' })
    expect(await app.processAcceptedRounds(world.manifest.address, 'after-cancel')).toBe(0)
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
    const aborted = await divergent.acceptRound(world.manifest.address, request('quarantine-aborted'))
    const occupied = new SessionDeliveryAdapter(persistence.sessionPath)
    await occupied.appendIfAbsent({
      sessionId: brandId('session:player', 'SessionId'),
      sessionDeliverySeq: 1,
      deliveryId: brandId('delivery:occupied', 'DeliveryId'),
      payloadHash: hashWorldJson('world-outbox-payload', { occupied: true }),
      observationEvent: { occupied: true },
      correlationId: 'occupied',
    })
    occupied.close()
    await expect(divergent.deliver(world.manifest.address, 'delivery:divergent')).rejects.toThrow('different content')
    expect(divergent.activeBranchCount).toBe(0)
    expect(divergent.quarantineExplain(world.manifest.address)).toMatchObject({
      runtimePhase: 'quarantined', failures: [{ error: { errorCode: 'SESSION_DELIVERY_DIVERGED' } }],
    })
    await expect(divergent.roundStatus(world.manifest.address, { roundId: aborted.roundId })).resolves.toMatchObject({
      status: 'failed', result: { errorCode: 'SESSION_DELIVERY_DIVERGED' },
    })
    await expect(divergent.acceptRound(world.manifest.address, request('quarantine-aborted'))).resolves.toMatchObject({
      status: 'failed', roundId: aborted.roundId,
    })
    await expect(divergent.quarantineRecover(world.manifest.address, 'quarantine:still-divergent'))
      .rejects.toMatchObject({ envelope: { errorCode: 'RECOVERY_VALIDATION_FAILED' } })
    const clearDivergence = new DatabaseSync(persistence.sessionPath)
    clearDivergence.exec(`DELETE FROM session_events; DELETE FROM session_delivery_inbox; DELETE FROM session_delivery_cursor;`)
    clearDivergence.close()
    await expect(divergent.quarantineRecover(world.manifest.address, 'quarantine:recovered')).resolves.toMatchObject({
      status: 'recovered', runtimeEpoch: 1,
    })
    await expect(divergent.roundStatus(world.manifest.address, { roundId: aborted.roundId })).resolves.toMatchObject({ status: 'failed' })
    expect(divergent.quarantineExplain(world.manifest.address)).toMatchObject({ runtimePhase: 'active' })
    const deadLetter = (await divergent.deadLetters(world.manifest.address))[0]!
    await divergent.retryDeadLetter(world.manifest.address, deadLetter.deliveryId, 'quarantine:retry-delivery')
    await expect(divergent.deliver(world.manifest.address, 'quarantine:redeliver')).resolves.toBe(1)
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

    const missingManifest = new WorldApplication(paths())
    await expect(missingManifest.acceptRound(world.manifest.address, request('missing-manifest')))
      .rejects.toThrow('no active Compiled Manifest')
    await missingManifest.close()
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

  it('quarantines projection and Session reconstruction invariants at the Application boundary', async () => {
    const projectionPaths = paths()
    const world = compiled()
    const projectionApp = new WorldApplication(projectionPaths)
    projectionApp.activate(world)
    const malformed = new WorldStore(projectionPaths.worldPath)
    const head = malformed.head(world.manifest.address)
    await malformed.commitRound({
      address: world.manifest.address,
      transactionId: brandId('transaction:malformed-projection', 'TransactionId'),
      roundId: brandId('round:malformed-projection', 'InteractionRoundId'),
      expectedHeadSeq: head.headSeq,
      expectedTick: head.tick,
      nextTick: head.tick + 1,
      events: [{ eventType: 'claim.upsert', eventVersion: 1, data: { value: true } }],
      outbox: [],
      correlationId: 'projection:malformed',
    })
    malformed.close()
    await expect(projectionApp.characterView(
      world.manifest.address,
      brandId('character:player', 'CharacterId'),
    )).rejects.toMatchObject({ envelope: { errorCode: 'PROJECTION_INVARIANT_FAILED' } })
    expect(projectionApp.activeBranchCount).toBe(0)
    await expect(projectionApp.quarantineRecover(world.manifest.address, 'projection:recovery'))
      .rejects.toMatchObject({ envelope: { errorCode: 'RECOVERY_VALIDATION_FAILED' } })
    await projectionApp.close()

    const sessionPaths = paths()
    const sessionApp = new WorldApplication(sessionPaths)
    sessionApp.activate(world)
    await sessionApp.submit(world.manifest.address, request('session-corruption'))
    await sessionApp.deliver(world.manifest.address, 'session:deliver')
    const corruptSession = new DatabaseSync(sessionPaths.sessionPath)
    corruptSession.prepare(`UPDATE session_events SET payload_json = 'not-json'`).run()
    corruptSession.close()
    await expect(sessionApp.renderSession(
      world.manifest.address,
      brandId('session:player', 'SessionId'),
      1,
    )).rejects.toMatchObject({ envelope: { errorCode: 'SESSION_DELIVERY_DIVERGED' } })
    expect(sessionApp.quarantineExplain(world.manifest.address)).toMatchObject({ runtimePhase: 'quarantined' })
    await sessionApp.close()

    const missingSessionPaths = paths()
    const missingSessionApp = new WorldApplication(missingSessionPaths)
    missingSessionApp.activate(world)
    const manualQuarantine = new BranchQuarantineService(missingSessionPaths.worldPath)
    manualQuarantine.quarantine({
      address: world.manifest.address,
      error: createErrorEnvelope({
        errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: 'missing Session recovery fixture',
        retryable: false, correlationId: 'session:missing', address: world.manifest.address,
      }),
      source: 'application.test',
    })
    manualQuarantine.close()
    await expect(missingSessionApp.quarantineRecover(world.manifest.address, 'session:missing-recovery'))
      .rejects.toMatchObject({ envelope: { errorCode: 'RECOVERY_VALIDATION_FAILED' } })
    await missingSessionApp.close()

    const roundPaths = paths()
    const roundApp = new WorldApplication(roundPaths)
    roundApp.activate(world)
    await roundApp.submit(world.manifest.address, request('round-status-corruption'))
    await roundApp.release(world.manifest.address)
    const corruptRound = new DatabaseSync(roundPaths.worldPath)
    corruptRound.prepare(`UPDATE round_inbox SET result_hash = 'sha256:wrong' WHERE idempotency_key = ?`)
      .run('round-status-corruption')
    corruptRound.close()
    await expect(roundApp.roundStatus(world.manifest.address, { idempotencyKey: 'round-status-corruption' }))
      .rejects.toMatchObject({ envelope: { errorCode: 'BUNDLE_HASH_MISMATCH' } })
    expect(roundApp.quarantineExplain(world.manifest.address)).toMatchObject({ runtimePhase: 'quarantined' })
    await roundApp.close()
  })

  it('validates pending, delivered, and rebound Session state before quarantine recovery', async () => {
    const world = compiled()
    const quarantine = (worldPath: string, address: WorldAddress, suffix: string) => {
      const service = new BranchQuarantineService(worldPath)
      service.quarantine({
        address,
        error: createErrorEnvelope({
          errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: `recovery fixture ${suffix}`,
          retryable: false, correlationId: `recovery:${suffix}`, address,
        }),
        source: 'application.recovery.test',
      })
      service.close()
    }

    const pendingPaths = paths()
    const pending = new WorldApplication(pendingPaths)
    pending.activate(world)
    await pending.submit(world.manifest.address, request('recovery-pending'))
    quarantine(pendingPaths.worldPath, world.manifest.address, 'pending')
    await expect(pending.quarantineRecover(world.manifest.address, 'recovery:pending-verified'))
      .resolves.toMatchObject({ status: 'recovered' })
    await pending.close()

    const deliveredPaths = paths()
    const delivered = new WorldApplication(deliveredPaths)
    delivered.activate(world)
    await delivered.submit(world.manifest.address, request('recovery-delivered'))
    await delivered.deliver(world.manifest.address, 'recovery:delivered')
    await delivered.release(world.manifest.address)
    const clearDelivered = new DatabaseSync(deliveredPaths.sessionPath)
    clearDelivered.exec(`DELETE FROM session_events; DELETE FROM session_delivery_inbox; DELETE FROM session_delivery_cursor;`)
    clearDelivered.close()
    quarantine(deliveredPaths.worldPath, world.manifest.address, 'delivered-missing')
    await expect(delivered.quarantineRecover(world.manifest.address, 'recovery:delivered-missing'))
      .rejects.toMatchObject({ envelope: { errorCode: 'RECOVERY_VALIDATION_FAILED' } })
    await delivered.close()

    const reboundPaths = paths()
    const rebound = new WorldApplication(reboundPaths)
    rebound.activate(world)
    await rebound.submit(world.manifest.address, request('recovery-rebound'))
    await rebound.deliver(world.manifest.address, 'recovery:rebound')
    await rebound.release(world.manifest.address)
    const reboundOutbox = new WorldOutbox(reboundPaths.worldPath)
    const authoritative = reboundOutbox.deliveryLedger(world.manifest.address, 'recovery:ledger')[0]!
    reboundOutbox.close()
    const reboundStore = new WorldStore(reboundPaths.worldPath)
    const authoritativePayload = reboundStore.readOutbox(world.manifest.address)[0]!.payload
    reboundStore.close()
    const clearRebound = new DatabaseSync(reboundPaths.sessionPath)
    clearRebound.exec(`DELETE FROM session_events; DELETE FROM session_delivery_inbox; DELETE FROM session_delivery_cursor;`)
    clearRebound.close()
    const reboundSession = new SessionDeliveryAdapter(reboundPaths.sessionPath)
    await reboundSession.appendIfAbsent({
      sessionId: brandId('session:rebound', 'SessionId'),
      sessionDeliverySeq: 1,
      deliveryId: authoritative.deliveryId,
      payloadHash: authoritative.payloadHash,
      observationEvent: authoritativePayload,
      correlationId: 'recovery:rebound-foreign-session',
    })
    reboundSession.close()
    quarantine(reboundPaths.worldPath, world.manifest.address, 'rebound')
    await expect(rebound.quarantineRecover(world.manifest.address, 'recovery:rebound-check'))
      .rejects.toMatchObject({ envelope: { errorCode: 'RECOVERY_VALIDATION_FAILED' } })
    await rebound.close()

    const aheadPaths = paths()
    const ahead = new WorldApplication(aheadPaths)
    ahead.activate(world)
    await ahead.submit(world.manifest.address, request('recovery-session-ahead'))
    await ahead.deliver(world.manifest.address, 'recovery:session-ahead-deliver')
    await ahead.release(world.manifest.address)
    const aheadSession = new SessionDeliveryAdapter(aheadPaths.sessionPath)
    const extraPayload = { source: 'future-restored-away' }
    await aheadSession.appendIfAbsent({
      sessionId: brandId('session:player', 'SessionId'),
      sessionDeliverySeq: 2,
      deliveryId: brandId('delivery:session-ahead', 'DeliveryId'),
      payloadHash: hashWorldJson('world-outbox-payload', extraPayload),
      observationEvent: extraPayload,
      correlationId: 'recovery:session-ahead-fixture',
    })
    aheadSession.close()
    quarantine(aheadPaths.worldPath, world.manifest.address, 'session-ahead')
    await expect(ahead.quarantineRecover(world.manifest.address, 'recovery:session-ahead-check'))
      .rejects.toMatchObject({ envelope: { errorCode: 'RECOVERY_VALIDATION_FAILED' } })
    await ahead.close()

    const snapshotPaths = paths()
    const snapshotApp = new WorldApplication(snapshotPaths)
    snapshotApp.activate(world)
    const snapshotPath = join(snapshotPaths.worldPath, '..', 'typed-snapshot.sqlite')
    await snapshotApp.createSnapshot(world.manifest.address, snapshotPath, 'snapshot:typed')
    const corruptSnapshot = new DatabaseSync(snapshotPath)
    corruptSnapshot.prepare(`UPDATE snapshot_bundles SET bundle_hash = 'sha256:wrong'`).run()
    corruptSnapshot.close()
    await expect(snapshotApp.createSnapshot(world.manifest.address, snapshotPath, 'snapshot:typed-retry'))
      .rejects.toMatchObject({ envelope: { errorCode: 'BUNDLE_HASH_MISMATCH' } })
    expect(snapshotApp.quarantineExplain(world.manifest.address)).toMatchObject({ runtimePhase: 'quarantined' })
    await snapshotApp.close()
  })
})
