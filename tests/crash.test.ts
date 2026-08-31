import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, createErrorEnvelope, hashWorldJson, type SubmitActionsV2 } from '@harness-world/contracts'
import { WorldSpecCompiler } from '@harness-world/kernel'
import { CognitiveMemoryService } from '@harness-world/memory'
import { LocalJsonRpcRouter, WorldHostInstanceLock } from '@harness-world/operations'
import {
  BranchQuarantineService,
  CharacterRuntimeAvailabilityService,
  SessionDeliveryAdapter,
  RoundInbox,
  WorldArchiveService,
  WorldOutbox,
  WorldStore,
  WriterLeaseService,
} from '@harness-world/store-sqlite'
import {
  fixtureAddress,
  fixtureCommitRequest,
  fixtureDeliveryRequest,
  hardKillAt,
} from '@harness-world/testkit'
import { phase8ProviderCrashWorld } from './fixtures/phase8-provider-world.ts'

const directories: string[] = []
const worker = fileURLToPath(new URL('./workers/crash-worker.ts', import.meta.url))
const archiveWorker = fileURLToPath(new URL('./workers/archive-crash-worker.ts', import.meta.url))
const applicationWorker = fileURLToPath(new URL('./workers/application-crash-worker.ts', import.meta.url))
const quarantineWorker = fileURLToPath(new URL('./workers/quarantine-crash-worker.ts', import.meta.url))
const acceptedRoundWorker = fileURLToPath(new URL('./workers/accepted-round-crash-worker.ts', import.meta.url))
const instanceLockWorker = fileURLToPath(new URL('./workers/instance-lock-crash-worker.ts', import.meta.url))
const memoryV2Worker = fileURLToPath(new URL('./workers/memory-v2-crash-worker.ts', import.meta.url))
const providerCallWorker = fileURLToPath(new URL('./workers/provider-call-crash-worker.ts', import.meta.url))

function database(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-crash-'))
  directories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
describe('hard process termination recovery', () => {
  it('rolls back a complete Reaction Round when killed after Wave settlement but before commit', async () => {
    const path = database('reaction.after-wave-settle.sqlite')
    const address = fixtureAddress()
    const observer = brandId('character:reaction-settle-crash', 'CharacterId')
    const setup = new WorldStore(path)
    setup.createBranch(address)
    const leases = new WriterLeaseService(path)
    const writer = leases.acquire(address, 'reaction-worker:crash-settle', 100_000)
    await setup.commitRound({
      ...fixtureCommitRequest(address),
      events: [{
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: { id: 'observation:reaction-settle-crash', value: { observerId: observer, content: 'stimulus' } },
      }],
      reactionCycle: {
        policyVersion: 'reaction-policy/v1',
        profileId: 'responsive/v1',
        maxWaves: 3,
        maxNpcCalls: 8,
        maxCallsPerCharacter: 2,
        maxActionsPerCall: 1,
        allowedActionTypes: ['speak@1'],
        initialTokenBudget: 8,
        deadlineAtMs: Date.now() + 100_000,
        candidates: [{
          characterId: observer,
          estimatedTokens: 1,
          stimuli: [{
            sourceEventOrdinal: 0,
            observationOrdinal: 0,
            observationId: 'observation:reaction-settle-crash',
            observerCharacterId: observer,
          }],
        }],
      },
      writerFencingToken: writer.fencingToken,
    })
    const claimed = setup.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 100_000)!
    setup.bindReactionJobProvider(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, {
        contextReceiptId: 'context-receipt:reaction-crash-settle',
        contextReceiptHash: hashWorldJson('context-receipt:test', 'reaction-crash-settle'),
        providerCallId: 'provider-call:reaction-crash-settle',
        providerRequestHash: hashWorldJson('provider-request:test', 'reaction-crash-settle'),
      },
    )
    setup.close()
    leases.close()

    await hardKillAt(worker, ['reaction-settle', path, 'reaction.after-wave-settle'])

    const recovered = new WorldStore(path)
    expect(recovered.head(address)).toMatchObject({ headSeq: 1, tick: 1 })
    expect(recovered.committedRound(address, brandId('transaction:reaction-crash-settle', 'TransactionId'))).toBeUndefined()
    const bundle = recovered.activeReactionCycle(address)!
    const job = bundle.jobs.find(value => value.status === 'claimed')!
    expect(bundle.waves[0]?.status).toBe('frozen')
    expect(job).toMatchObject({ status: 'claimed', providerCallId: 'provider-call:reaction-crash-settle' })
    await expect(recovered.commitRound({
      address,
      transactionId: brandId('transaction:reaction-crash-settle', 'TransactionId'),
      roundId: brandId('round:reaction-crash-settle', 'InteractionRoundId'),
      expectedHeadSeq: 1,
      expectedTick: 1,
      nextTick: 2,
      events: [{ eventType: 'fixture.reaction', eventVersion: 1, data: { text: 'settle after crash' } }],
      outbox: [],
      authority: { schemaVersion: 1, origin: 'reaction', cycleId: bundle.cycle.cycleId, wave: 1 },
      reactionSettlement: {
        cycleId: bundle.cycle.cycleId,
        wave: 1,
        terminalReason: 'quiescent',
        jobs: [{
          jobId: job.jobId,
          claimOwnerId: job.claimOwnerId!,
          claimFencingToken: job.claimFencingToken!,
          expectedStateHash: job.stateHash,
          outcome: 'proposed',
          proposalHash: hashWorldJson('reaction-proposal:test', 'crash-settle'),
        }],
      },
      writerFencingToken: 1,
      correlationId: 'reaction-crash-settle:recovery',
    })).resolves.toMatchObject({ status: 'committed', headSeq: 2, tick: 2 })
    expect(recovered.readReactionCycle(address, bundle.cycle.cycleId)?.cycle.status).toBe('terminal')
    recovered.close()
  })

  it('rolls back the next Wave together with its Reaction Round when killed before commit', async () => {
    const path = database('reaction.after-wave-continuation.sqlite')
    const address = fixtureAddress()
    const observer = brandId('character:reaction-settle-crash', 'CharacterId')
    const nextObserver = brandId('character:reaction-next-crash', 'CharacterId')
    const setup = new WorldStore(path)
    setup.createBranch(address)
    const leases = new WriterLeaseService(path)
    const writer = leases.acquire(address, 'reaction-worker:crash-continue', 100_000)
    await setup.commitRound({
      ...fixtureCommitRequest(address),
      events: [{
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: { id: 'observation:reaction-settle-crash', value: { observerId: observer, content: 'stimulus' } },
      }],
      reactionCycle: {
        policyVersion: 'reaction-policy/v1',
        profileId: 'responsive/v1',
        maxWaves: 3,
        maxNpcCalls: 8,
        maxCallsPerCharacter: 2,
        maxActionsPerCall: 1,
        allowedActionTypes: ['speak@1'],
        initialTokenBudget: 8,
        deadlineAtMs: Date.now() + 100_000,
        candidates: [{
          characterId: observer,
          estimatedTokens: 1,
          stimuli: [{
            sourceEventOrdinal: 0,
            observationOrdinal: 0,
            observationId: 'observation:reaction-settle-crash',
            observerCharacterId: observer,
          }],
        }],
      },
      writerFencingToken: writer.fencingToken,
    })
    const claimed = setup.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 100_000)!
    setup.bindReactionJobProvider(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, {
        contextReceiptId: 'context-receipt:reaction-crash-continue',
        contextReceiptHash: hashWorldJson('context-receipt:test', 'reaction-crash-continue'),
        providerCallId: 'provider-call:reaction-crash-continue',
        providerRequestHash: hashWorldJson('provider-request:test', 'reaction-crash-continue'),
      },
    )
    setup.close()
    leases.close()

    await hardKillAt(worker, ['reaction-continue', path, 'reaction.after-wave-settle'])

    const recovered = new WorldStore(path)
    expect(recovered.head(address)).toMatchObject({ headSeq: 1, tick: 1 })
    const bundle = recovered.activeReactionCycle(address)!
    expect(bundle.waves).toHaveLength(1)
    const job = bundle.jobs.find(value => value.status === 'claimed')!
    await expect(recovered.commitRound({
      address,
      transactionId: brandId('transaction:reaction-crash-settle', 'TransactionId'),
      roundId: brandId('round:reaction-crash-settle', 'InteractionRoundId'),
      expectedHeadSeq: 1,
      expectedTick: 1,
      nextTick: 2,
      events: [{
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: {
          id: 'observation:reaction-next-crash',
          value: { observerId: nextObserver, content: 'continue after crash' },
        },
      }],
      outbox: [],
      authority: { schemaVersion: 1, origin: 'reaction', cycleId: bundle.cycle.cycleId, wave: 1 },
      reactionSettlement: {
        cycleId: bundle.cycle.cycleId,
        wave: 1,
        terminalReason: null,
        jobs: [{
          jobId: job.jobId,
          claimOwnerId: job.claimOwnerId!,
          claimFencingToken: job.claimFencingToken!,
          expectedStateHash: job.stateHash,
          outcome: 'proposed',
          proposalHash: hashWorldJson('reaction-proposal:test', 'crash-settle'),
        }],
        nextWaveCandidates: [{
          characterId: nextObserver,
          estimatedTokens: 1,
          stimuli: [{
            sourceEventOrdinal: 0,
            observationOrdinal: 0,
            observationId: 'observation:reaction-next-crash',
            observerCharacterId: nextObserver,
          }],
        }],
      },
      writerFencingToken: 1,
      correlationId: 'reaction-crash-continue:recovery',
    })).resolves.toMatchObject({ status: 'committed', headSeq: 2, tick: 2 })
    const continued = recovered.activeReactionCycle(address)!
    expect(continued.waves).toHaveLength(2)
    expect(continued.waves[1]).toMatchObject({ wave: 2, status: 'frozen', baseHeadSeq: 2 })
    expect(continued.jobs.find(value => value.wave === 2)).toMatchObject({ characterId: nextObserver, status: 'pending' })
    recovered.close()
  })

  it.each([
    'reaction.after-player-enqueue',
    'reaction.after-player-preempt',
  ] as const)('atomically rolls back player admission and Reaction preemption at %s', async point => {
    const path = database(`${point}.sqlite`)
    const address = fixtureAddress()
    const observer = brandId('character:reaction-crash', 'CharacterId')
    const setup = new WorldStore(path)
    setup.createBranch(address)
    await setup.commitRound({
      ...fixtureCommitRequest(address),
      events: [{
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: { id: 'observation:reaction-crash', value: { observerId: observer, content: 'stimulus' } },
      }],
      reactionCycle: {
        policyVersion: 'reaction-policy/v1',
        profileId: 'responsive/v1',
        maxWaves: 3,
        maxNpcCalls: 8,
        maxCallsPerCharacter: 2,
        maxActionsPerCall: 1,
        allowedActionTypes: ['speak@1'],
        initialTokenBudget: 8,
        deadlineAtMs: 10_000,
        candidates: [{
          characterId: observer,
          estimatedTokens: 1,
          stimuli: [{
            sourceEventOrdinal: 0,
            observationOrdinal: 0,
            observationId: 'observation:reaction-crash',
            observerCharacterId: observer,
          }],
        }],
      },
    })
    setup.close()

    await hardKillAt(worker, ['reaction-preempt', path, point])

    const recoveredStore = new WorldStore(path)
    expect(recoveredStore.activeReactionCycle(address)?.cycle.status).toBe('active')
    const recoveredInbox = new RoundInbox(path)
    expect(recoveredInbox.readStatus(address, { idempotencyKey: 'reaction:player-preempt' })).toBeUndefined()
    expect(recoveredInbox.enqueue({
      address,
      idempotencyKey: 'reaction:player-preempt',
      principalId: 'principal:player',
      input: { type: 'speak', text: 'interrupt' },
      correlationId: 'reaction:player-preempt:recovery',
    }, 1)).toMatchObject({ status: 'enqueued', inboxSeq: 1 })
    expect(recoveredStore.activeReactionCycle(address)?.cycle).toMatchObject({
      status: 'stop_requested', stopReason: 'player_preempted',
    })
    recoveredInbox.close()
    recoveredStore.close()
  })

  it('recovers an instance lock only after its owner process is hard-killed', async () => {
    const worldPath = database('instance-lock-world.sqlite')
    const lockPath = join(dirname(worldPath), 'instance.lock')
    await hardKillAt(instanceLockWorker, [lockPath, worldPath])
    const recovered = WorldHostInstanceLock.acquire(lockPath, worldPath)
    expect(recovered.record.pid).toBe(process.pid)
    recovered.release()
  })

  it.each([
    ['store.after-event-insert', 0],
    ['store.before-commit', 0],
    ['store.after-commit', 1],
  ] as const)('recovers the complete World transaction at %s', async (point, expectedHead) => {
    const path = database(`${point}.sqlite`)
    const setup = new WorldStore(path)
    setup.createBranch(fixtureAddress())
    setup.close()
    await hardKillAt(worker, ['world', path, point])
    const recovered = new WorldStore(path)
    expect(recovered.head(fixtureAddress()).headSeq).toBe(expectedHead)
    expect(recovered.readEvents(fixtureAddress())).toHaveLength(expectedHead)
    expect(recovered.readOutbox(fixtureAddress())).toHaveLength(expectedHead)
    expect(recovered.readCognitiveJobs(fixtureAddress(), true)).toHaveLength(expectedHead)
    expect(recovered.readRoundAuthority(fixtureAddress(), fixtureCommitRequest().transactionId) !== undefined)
      .toBe(expectedHead === 1)
    recovered.close()
  })

  it('reuses committed Cognitive Memory after termination before the World job receipt', async () => {
    const worldPath = database('memory-v2-world.sqlite')
    const memoryPath = worldPath.replace('memory-v2-world.sqlite', 'memory-v2.sqlite')
    const setup = new WorldStore(worldPath)
    setup.createBranch(fixtureAddress())
    await setup.commitRound({
      ...fixtureCommitRequest(),
      events: [
        {
          eventType: 'character.created', eventVersion: 1,
          data: { characterId: 'character:crash-fixture', locationId: 'location:crash-fixture' },
        },
        {
          eventType: 'observation.upsert', eventVersion: 1,
          data: {
            id: 'observation:crash-fixture',
            value: { observerId: 'character:crash-fixture', content: 'durable crash memory' },
          },
        },
      ],
    })
    setup.close()

    await hardKillAt(memoryV2Worker, [worldPath, memoryPath])

    const recoveredWorld = new WorldStore(worldPath)
    const recoveredLeases = new WriterLeaseService(worldPath)
    const lease = recoveredLeases.acquire(fixtureAddress(), 'memory:v2-crash-worker', 10_000)
    const recoveredMemory = new CognitiveMemoryService(memoryPath, recoveredWorld, undefined, 2)
    const before = recoveredMemory.watermark(
      fixtureAddress(), brandId('character:crash-fixture', 'CharacterId'),
    )
    expect(before).toMatchObject({ verifiedThroughSeq: 2, capturedThroughSeq: 2, memoryEpoch: 1 })
    expect(recoveredWorld.readCognitiveJobs(fixtureAddress(), true)[0]).toMatchObject({
      status: 'pending', attemptCount: 0,
    })

    expect(recoveredMemory.processPending(
      fixtureAddress(), 'memory:v2-crash-worker', lease.fencingToken,
      () => { recoveredLeases.renew(fixtureAddress(), 'memory:v2-crash-worker', lease.fencingToken, 10_000) },
    )).toEqual({ completed: 1, failed: [] })
    expect(recoveredMemory.watermark(
      fixtureAddress(), brandId('character:crash-fixture', 'CharacterId'),
    )).toEqual(before)
    expect(recoveredWorld.readCognitiveJobs(fixtureAddress(), true)[0]).toMatchObject({
      status: 'completed', attemptCount: 1,
    })
    recoveredMemory.close()
    recoveredLeases.close()
    recoveredWorld.close()
  })

  it.each([
    ['session-delivery.after-inbox-insert', 0],
    ['session-delivery.after-observation-append', 0],
    ['session-delivery.after-commit', 1],
  ] as const)('recovers the complete Session delivery at %s', async (point, expectedCursor) => {
    const path = database(`${point}.sqlite`)
    await hardKillAt(worker, ['session', path, point])
    const recovered = new SessionDeliveryAdapter(path)
    expect(recovered.cursor(fixtureDeliveryRequest().sessionId)).toBe(expectedCursor)
    expect(recovered.readEvent(fixtureDeliveryRequest().sessionId, 1) !== undefined).toBe(expectedCursor === 1)
    recovered.close()
  })

  it.each([
    ['outbox.before-receipt-commit', false],
    ['outbox.after-receipt-commit', true],
  ] as const)('recovers the complete sender Receipt at %s', async (point, expectedReceipt) => {
    const path = database(`${point}.sqlite`)
    const setup = new WorldStore(path)
    setup.createBranch(fixtureAddress())
    await setup.commitRound(fixtureCommitRequest())
    setup.close()
    await hardKillAt(worker, ['outbox', path, point])
    const recovered = new WorldOutbox(path, undefined, {
      workerId: 'worker:crash-recovery',
      now: () => Number.MAX_SAFE_INTEGER,
    })
    const deliveryId = fixtureCommitRequest().outbox[0]!.deliveryId
    expect(recovered.hasReceipt(deliveryId)).toBe(expectedReceipt)
    expect(recovered.claimNext(fixtureAddress()) === undefined).toBe(expectedReceipt)
    recovered.close()
  })

  it.each([
    ['quarantine.before-commit', 'active', 0],
    ['quarantine.after-commit', 'quarantined', 1],
  ] as const)('recovers an atomic Branch barrier at %s', async (point, runtimePhase, failureCount) => {
    const path = database(`${point}.sqlite`)
    const setup = new WorldStore(path)
    setup.createBranch(fixtureAddress())
    setup.close()
    await hardKillAt(quarantineWorker, ['quarantine', path, point])
    const recovered = new BranchQuarantineService(path)
    expect(recovered.explain(fixtureAddress())).toMatchObject({ runtimePhase })
    expect(recovered.explain(fixtureAddress()).failures).toHaveLength(failureCount)
    recovered.close()
  })

  it.each([
    ['quarantine-recovery.after-maintenance-commit', 'maintenance'],
    ['quarantine-recovery.before-commit', 'maintenance'],
    ['quarantine-recovery.after-commit', 'active'],
  ] as const)('recovers or resumes controlled Branch recovery at %s', async (point, runtimePhase) => {
    const path = database(`${point}.sqlite`)
    const address = fixtureAddress()
    const store = new WorldStore(path)
    store.createBranch(address)
    store.close()
    const setup = new BranchQuarantineService(path)
    setup.quarantine({
      address,
      error: createErrorEnvelope({
        errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: 'hard-crash recovery fixture',
        retryable: false, correlationId: 'crash:recovery-setup', address,
      }),
      source: 'crash.test',
    })
    setup.close()
    await hardKillAt(quarantineWorker, ['recover', path, point])
    const recovered = new BranchQuarantineService(path)
    expect(recovered.explain(address)).toMatchObject({ runtimePhase })
    if (runtimePhase === 'maintenance') {
      expect(recovered.recover(address, 'crash:recovery-resume', () => ({ verified: true })))
        .toMatchObject({ status: 'recovered', runtimeEpoch: 1 })
    }
    expect(recovered.explain(address)).toMatchObject({ runtimePhase: 'active', failures: [{ status: 'recovered' }] })
    recovered.close()
  })

  it('leaves a valid backup after termination immediately following backup completion', async () => {
    const sourcePath = database('archive-source.sqlite')
    const targetPath = sourcePath.replace('archive-source.sqlite', 'archive-target.sqlite')
    const setup = new WorldStore(sourcePath)
    setup.createBranch(fixtureAddress())
    await setup.commitRound(fixtureCommitRequest())
    setup.close()
    await hardKillAt(archiveWorker, ['backup', sourcePath, targetPath])
    const recovered = new WorldStore(targetPath)
    expect(recovered.head(fixtureAddress()).headSeq).toBe(1)
    recovered.close()
  })

  it('leaves a valid restore after termination immediately following restore validation', async () => {
    const sourcePath = database('restore-source.sqlite')
    const backupPath = sourcePath.replace('restore-source.sqlite', 'restore-backup.sqlite')
    const targetPath = sourcePath.replace('restore-source.sqlite', 'restore-target.sqlite')
    const setup = new WorldStore(sourcePath)
    setup.createBranch(fixtureAddress())
    await setup.commitRound(fixtureCommitRequest())
    setup.close()
    const artifact = await new WorldArchiveService(sourcePath).backup(backupPath, 'crash:restore-setup')
    await hardKillAt(archiveWorker, ['restore', backupPath, targetPath, artifact.fileHash])
    const recovered = new WorldStore(targetPath)
    expect(recovered.readEvents(fixtureAddress())).toHaveLength(1)
    recovered.close()
  })

  it('recovers a committed application Round whose Inbox completion was interrupted by hard termination', async () => {
    const worldPath = database('application-world.sqlite')
    const sessionPath = worldPath.replace('application-world.sqlite', 'application-session.sqlite')
    const compiled = new WorldSpecCompiler().compile({
      schemaVersion: 1,
      address: { tenantId: 'tenant:p6-crash', worldId: 'world:p6-crash', branchId: 'branch:main' },
      timeMode: 'TURN_DRIVEN',
      roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:room', name: 'Room' }],
      characters: [
        { characterId: 'character:player', name: 'Player', locationId: 'location:room' },
        { characterId: 'character:npc', name: 'NPC', locationId: 'location:room' },
      ],
      playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
      plugins: [],
    })
    const setup = new WorldApplication({ worldPath, sessionPath, runtimeOwnerId: 'application:p6-crash' })
    setup.activate(compiled)
    await setup.close()
    await hardKillAt(applicationWorker, [worldPath, sessionPath, 'store.after-commit'])

    const committedStore = new WorldStore(worldPath)
    const committedHashes = committedStore.readEvents(compiled.manifest.address).map(event => event.eventHash)
    expect(committedStore.readEvents(compiled.manifest.address)
      .some(event => JSON.stringify(event.data).includes('provider output A before hard kill'))).toBe(true)
    committedStore.close()
    let recoveredProviderCalls = 0
    const recovered = new WorldApplication({
      worldPath,
      sessionPath,
      runtimeOwnerId: 'application:p6-crash',
      leaseTtlMs: 2_000,
      modelBudgetTokens: 10,
      participants: () => [{
        participantId: 'agent:p6-crash',
        role: 'agent',
        actorId: brandId('character:npc', 'CharacterId'),
        allowedActionTypes: ['speak'],
        priority: 1,
        estimatedTokens: 1,
        timeoutMs: 100,
        provider: {
          propose: async context => {
            recoveredProviderCalls += 1
            return {
              participantId: 'agent:p6-crash',
              actions: [{
                actionId: `action:recovered:${context.roundId}`,
                actorId: brandId('character:npc', 'CharacterId'),
                actionType: 'speak',
                actionVersion: 1,
                parameters: { text: 'provider output B after restart' },
              }],
            }
          },
        },
      }],
    })
    const recoveryRequest = {
      idempotencyKey: 'p6-crash-round',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'durable across hard kill' } },
      correlationId: 'p6-crash-recovery',
    } as const
    await expect(recovered.submit(compiled.manifest.address, recoveryRequest)).rejects.toMatchObject({
      envelope: { errorCode: 'WORLDSTORE_BUSY' },
    })
    const leaseDatabase = new DatabaseSync(worldPath, { readOnly: true })
    const activeLease = leaseDatabase.prepare(`SELECT expires_at_ms FROM writer_leases`).get() as { expires_at_ms: number }
    leaseDatabase.close()
    expect(activeLease.expires_at_ms).toBeGreaterThan(Date.now())
    await new Promise(resolve => setTimeout(resolve, Math.max(0, activeLease.expires_at_ms - Date.now() + 20)))
    const result = await recovered.submit(compiled.manifest.address, recoveryRequest)
    expect(result).toMatchObject({ status: 'accepted', tick: 1 })
    expect(recoveredProviderCalls).toBe(0)
    expect(await recovered.roundResult(compiled.manifest.address, 'p6-crash-round')).toEqual(result)
    const verifiedStore = new WorldStore(worldPath)
    expect(verifiedStore.readEvents(compiled.manifest.address).map(event => event.eventHash)).toEqual(committedHashes)
    verifiedStore.close()
    expect(await recovered.deliver(compiled.manifest.address, 'p6-crash-delivery')).toBe(2)
    await expect(recovered.submit(compiled.manifest.address, {
      idempotencyKey: 'p6-crash-next-round',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'FIFO continues after recovery' } },
      correlationId: 'p6-crash-next-round',
    })).resolves.toMatchObject({ status: 'accepted', tick: 2 })
    expect(recoveredProviderCalls).toBe(1)
    await recovered.close()
  })

  it('startup-scans and completes a claimed Round after hard worker termination', async () => {
    const worldPath = database('accepted-crash-world.sqlite')
    const sessionPath = worldPath.replace('accepted-crash-world.sqlite', 'accepted-crash-session.sqlite')
    const compiled = new WorldSpecCompiler().compile({
      schemaVersion: 1,
      address: { tenantId: 'tenant:accepted-crash', worldId: 'world:accepted-crash', branchId: 'branch:main' },
      timeMode: 'TURN_DRIVEN',
      roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:room', name: 'Room' }],
      characters: [{ characterId: 'character:player', name: 'Player', locationId: 'location:room' }],
      playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
      plugins: [],
    })
    const setup = new WorldApplication({ worldPath, sessionPath })
    setup.activate(compiled)
    await setup.close()
    await hardKillAt(acceptedRoundWorker, [worldPath, sessionPath])

    const recovered = new WorldApplication({ worldPath, sessionPath, leaseTtlMs: 1_000 })
    const router = new LocalJsonRpcRouter(worldPath, recovered)
    expect(router.recoverAcceptedRounds('crash:startup-scan')).toBe(1)
    await router.close()
    await expect(recovered.roundStatus(compiled.manifest.address, { idempotencyKey: 'accepted-crash-round' }))
      .resolves.toMatchObject({ status: 'committed', result: { status: 'accepted', tick: 1 } })
    await recovered.close()
  })

  it.each([
    ['provider.before-dispatch', 'prepared', 1, 'committed'],
    ['provider.after-dispatch', 'dispatch_started', 0, 'timed_out_ambiguous'],
    ['provider.after-response', 'response_received', 0, 'committed'],
    ['provider.before-world-commit', 'validated', 0, 'committed'],
  ] as const)(
    'recovers the Provider call lifecycle without duplicate dispatch at %s',
    async (point, interruptedState, expectedRecoveredCalls, finalState) => {
      const worldPath = database(`${point}-world.sqlite`)
      const sessionPath = worldPath.replace('-world.sqlite', '-session.sqlite')
      const memoryPath = worldPath.replace('-world.sqlite', '-memory.sqlite')
      const contextPath = `${memoryPath}.context.sqlite`
      const compiled = phase8ProviderCrashWorld()
      await hardKillAt(providerCallWorker, [worldPath, sessionPath, memoryPath, point])

      const interrupted = new DatabaseSync(contextPath, { readOnly: true })
      const interruptedCall = interrupted.prepare('SELECT state FROM provider_calls').get()
      interrupted.close()
      expect(interruptedCall).toEqual({ state: interruptedState })

      let recoveredCalls = 0
      const recovered = new WorldApplication({
        worldPath, sessionPath, memoryPath,
        runtimeOwnerId: 'application:p8-crash-recovered', leaseTtlMs: 500, modelBudgetTokens: 10,
        participants: () => [{
          participantId: 'agent:p8-crash', role: 'agent',
          actorId: brandId('character:npc', 'CharacterId'),
          allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
          provider: {
            async propose(): Promise<SubmitActionsV2> {
              recoveredCalls += 1
              return {
                schemaVersion: 2, decision: 'act',
                actions: [{
                  actionId: 'action:p8-crash:npc', actorId: brandId('character:npc', 'CharacterId'),
                  actionType: 'speak', actionVersion: 1, parameters: { text: 'durable provider response' },
                }],
              }
            },
          },
        }],
      })
      const leaseDatabase = new DatabaseSync(worldPath, { readOnly: true })
      const lease = leaseDatabase.prepare('SELECT expires_at_ms FROM writer_leases').get() as { expires_at_ms: number }
      leaseDatabase.close()
      await new Promise(resolve => setTimeout(resolve, Math.max(0, lease.expires_at_ms - Date.now() + 20)))
      await expect(recovered.submit(compiled.manifest.address, {
        idempotencyKey: 'p8-provider-crash-round', principalId: 'principal:player',
        action: { actionType: 'speak', parameters: { text: 'exercise provider crash boundary' } },
        correlationId: `recover:${point}`,
      })).resolves.toMatchObject({ status: 'accepted', tick: 1 })
      expect(recoveredCalls).toBe(expectedRecoveredCalls)
      await recovered.close()

      const final = new DatabaseSync(contextPath, { readOnly: true })
      const finalCall = final.prepare('SELECT state FROM provider_calls').get()
      final.close()
      expect(finalCall).toEqual({ state: finalState })
      const world = new WorldStore(worldPath)
      const head = world.head(compiled.manifest.address)
      const providerSpeech = world.readEvents(compiled.manifest.address).filter(event =>
        event.eventType === 'character.speak'
        && JSON.stringify(event.data).includes('durable provider response'))
      world.close()
      expect(head.tick).toBe(1)
      expect(providerSpeech).toHaveLength(point === 'provider.after-dispatch' ? 0 : 1)
    },
  )

  it('reconciles participant Availability after hard termination following World COMMIT', async () => {
    const worldPath = database('availability-after-commit-world.sqlite')
    const sessionPath = worldPath.replace('-world.sqlite', '-session.sqlite')
    const memoryPath = worldPath.replace('-world.sqlite', '-memory.sqlite')
    const compiled = phase8ProviderCrashWorld()
    await hardKillAt(providerCallWorker, [
      worldPath, sessionPath, memoryPath, 'store.after-commit', 'provider-failure',
    ])

    const interruptedAvailability = new CharacterRuntimeAvailabilityService(worldPath)
    expect(interruptedAvailability.get(
      compiled.manifest.address, brandId('character:npc', 'CharacterId'),
    )).toMatchObject({ state: 'ready' })
    interruptedAvailability.close()

    let recoveredCalls = 0
    const recovered = new WorldApplication({
      worldPath, sessionPath, memoryPath,
      runtimeOwnerId: 'application:p8-availability-recovered', leaseTtlMs: 500, modelBudgetTokens: 10,
      participants: () => [{
        participantId: 'agent:p8-crash', role: 'agent',
        actorId: brandId('character:npc', 'CharacterId'),
        allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
        provider: {
          async propose(): Promise<SubmitActionsV2> {
            recoveredCalls += 1
            throw new Error('committed Round must not dispatch again')
          },
        },
      }],
    })
    const leaseDatabase = new DatabaseSync(worldPath, { readOnly: true })
    const lease = leaseDatabase.prepare('SELECT expires_at_ms FROM writer_leases').get() as { expires_at_ms: number }
    leaseDatabase.close()
    await new Promise(resolve => setTimeout(resolve, Math.max(0, lease.expires_at_ms - Date.now() + 20)))
    await expect(recovered.submit(compiled.manifest.address, {
      idempotencyKey: 'p8-provider-crash-round', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'exercise provider crash boundary' } },
      correlationId: 'recover:availability-after-commit',
    })).resolves.toMatchObject({ status: 'accepted', tick: 1 })
    expect(recoveredCalls).toBe(0)
    await recovered.close()

    const recoveredAvailability = new CharacterRuntimeAvailabilityService(worldPath)
    expect(recoveredAvailability.get(
      compiled.manifest.address, brandId('character:npc', 'CharacterId'),
    )).toMatchObject({ state: 'model_unavailable', reason: 'provider failed' })
    recoveredAvailability.close()
  })
})
