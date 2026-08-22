import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId } from '@harness-world/contracts'
import { WorldSpecCompiler } from '@harness-world/kernel'
import { SessionDeliveryAdapter, WorldArchiveService, WorldOutbox, WorldStore } from '@harness-world/store-sqlite'
import {
  fixtureAddress,
  fixtureCommitRequest,
  fixtureDeliveryRequest,
  hardKillAt,
} from '@harness-world/testkit'

const directories: string[] = []
const worker = fileURLToPath(new URL('./workers/crash-worker.ts', import.meta.url))
const archiveWorker = fileURLToPath(new URL('./workers/archive-crash-worker.ts', import.meta.url))
const applicationWorker = fileURLToPath(new URL('./workers/application-crash-worker.ts', import.meta.url))

function database(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-crash-'))
  directories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
describe('hard process termination recovery', () => {
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
    recovered.close()
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
    const result = await recovered.submit(compiled.manifest.address, {
      idempotencyKey: 'p6-crash-round',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'durable across hard kill' } },
      correlationId: 'p6-crash-recovery',
    })
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
})
