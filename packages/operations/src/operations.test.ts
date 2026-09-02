import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldApplication, type ReactionParticipantBinding } from '@harness-world/application'
import { brandId, createErrorEnvelope, WorldError, type CharacterId, type FaultInjector, type ReactionAgentProvider, type ReactionProposalContext, type SubmitActionsV2, type WorldAddress } from '@harness-world/contracts'
import {
  BranchQuarantineService,
  BranchAdministration,
  CharacterRuntimeAvailabilityService,
  RoundInbox,
  SessionOutboxWorker,
  WORLD_APPLICATION_ID,
  WORLD_SCHEMA_VERSION,
  WorldOutbox,
  WorldStore,
  WriterLeaseService,
} from '@harness-world/store-sqlite'
import { executeLocalCli, parseLocalCli } from './cli.ts'
import { WorldHealthService } from './health.ts'
import { OperationsMetrics } from './metrics.ts'
import { LocalJsonRpcRouter, type LocalJsonRpcRequest, type LocalJsonRpcResponse, type WorldApplicationPort } from './rpc.ts'
import { ADDRESS, reactionBinding, roundProvider, v5Manifest, type ProviderScript } from '../../../tests/reaction-fixture.ts'

const directories: string[] = []

function fixture(): { directory: string; path: string; parent: WorldAddress; child: WorldAddress } {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-operations-'))
  directories.push(directory)
  return {
    directory,
    path: join(directory, 'world.sqlite'),
    parent: {
      tenantId: brandId('tenant:operations', 'TenantId'),
      worldId: brandId('world:operations', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    },
    child: {
      tenantId: brandId('tenant:operations', 'TenantId'),
      worldId: brandId('world:operations', 'WorldId'),
      branchId: brandId('branch:child', 'BranchId'),
    },
  }
}

function request(method: string, params = {}): LocalJsonRpcRequest {
  return { jsonrpc: '2.0', id: `request:${method}`, method, params }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('OperationsMetrics and WorldHealthService', () => {
  it('keeps fixed-cardinality counters and reports process, Branch, and capability health', async () => {
    const metrics = new OperationsMetrics()
    metrics.increment('rpc_requests', 2)
    expect(metrics.snapshot()).toMatchObject({ rpc_requests: 2, rpc_errors: 0 })
    expect(() => metrics.increment('rpc_errors', 0)).toThrow(RangeError)

    const { directory, path, parent } = fixture()
    expect(new WorldHealthService(path).check()).toMatchObject({ status: 'degraded', detail: 'world database is missing' })
    const app = new WorldApplication({ worldPath: path, sessionPath: join(directory, 'session.sqlite') })
    app.activateSpec({
      schemaVersion: 1,
      address: parent,
      timeMode: 'TURN_DRIVEN',
      roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:health', name: 'Health' }],
      characters: [{ characterId: 'character:health', name: 'Health', locationId: 'location:health' }],
      playerBindings: [{ principalId: 'principal:health', characterId: 'character:health', sessionId: 'session:health' }],
      plugins: [],
    })
    await app.submit(parent, {
      idempotencyKey: 'health:round', principalId: 'principal:health',
      action: { actionType: 'speak', parameters: { text: 'health' } }, correlationId: 'health:round',
    })
    await app.release(parent)
    expect(new WorldHealthService(path).check()).toMatchObject({
      status: 'ready', schemaVersion: WORLD_SCHEMA_VERSION, branchCount: 1,
      readyForRead: true, readyForWrite: true, readyForAgentCalls: true,
      branches: [{ status: 'healthy', readyForRead: true, readyForWrite: true, readyForAgentCalls: true,
        unavailableCharacterCount: 0, characterAvailability: [{ characterId: 'character:health', state: 'ready' }] }],
    })
    const runtimeAvailability = new CharacterRuntimeAvailabilityService(path)
    runtimeAvailability.set(parent, brandId('character:health', 'CharacterId'), 'offline', 'health test')
    expect(new WorldHealthService(path).check()).toMatchObject({
      branches: [{ status: 'degraded', readyForAgentCalls: false, unavailableCharacterCount: 1 }],
    })
    runtimeAvailability.set(parent, brandId('character:health', 'CharacterId'), 'ready', null)
    runtimeAvailability.close()
    const outbox = new WorldOutbox(path)
    const deadLetter = new SessionOutboxWorker(outbox, {
      appendIfAbsent: async () => { throw new Error('health dead letter') },
    }, parent, 1)
    await deadLetter.runOnce('health:dead-letter')
    outbox.close()
    expect(new WorldHealthService(path).check()).toMatchObject({
      branches: [{ status: 'degraded', readyForWrite: true, readyForAgentCalls: false, criticalDeadLetterCount: 1 }],
    })
    const quarantine = new BranchQuarantineService(path)
    quarantine.quarantine({
      address: parent,
      error: createErrorEnvelope({
        errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: 'health quarantine',
        retryable: false, correlationId: 'health:quarantine', address: parent,
      }),
      source: 'health.test',
    })
    expect(new WorldHealthService(path).check()).toMatchObject({
      branches: [{ status: 'quarantined', runtimePhase: 'quarantined', readyForWrite: false, openFailureCount: 1 }],
    })
    quarantine.close()
    await app.close()

    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA application_id = 1')
    raw.close()
    expect(new WorldHealthService(path).check()).toMatchObject({ status: 'degraded', detail: 'identity, schema, or integrity mismatch' })

    const schemaPath = join(directory, 'schema.sqlite')
    const schema = new DatabaseSync(schemaPath)
    schema.exec(`PRAGMA application_id = ${WORLD_APPLICATION_ID}; PRAGMA user_version = 5; CREATE TABLE branches(id INTEGER);`)
    schema.close()
    expect(new WorldHealthService(schemaPath).check()).toMatchObject({ status: 'degraded', schemaVersion: 5 })

    const corruptPath = join(directory, 'corrupt.sqlite')
    writeFileSync(corruptPath, 'not sqlite')
    expect(new WorldHealthService(corruptPath).check()).toMatchObject({ status: 'degraded', schemaVersion: null, detail: expect.stringContaining('failed') })
  })
})

describe('LocalJsonRpcRouter', () => {
  it('routes privacy-safe Reaction get/list/cancel operations and validates query shapes', async () => {
    const { path, parent } = fixture()
    const cycleId = brandId('reaction-cycle:rpc', 'ReactionCycleId')
    const queries: unknown[] = []
    let processCalls = 0
    const application = {
      async reactionCycle(_address: WorldAddress, requested: string) {
        return requested === cycleId ? { cycleId, status: 'active' } : undefined
      },
      async listReactionCycles(_address: WorldAddress, query: unknown) {
        queries.push(query)
        return [{ cycleId, status: 'active' }]
      },
      async cancelReactionCycle(_address: WorldAddress, requested: string, correlationId: string) {
        return { cycleId: requested, status: 'stop_requested', stopReason: 'user_cancelled', correlationId }
      },
      async processReactionCycles() {
        processCalls += 1
        if (processCalls === 2) return null
        if (processCalls === 3) return { cycleId: null, waves: [] }
        return { cycleId, waves: [{ wave: 1 }] }
      },
      async close() {},
    } as unknown as WorldApplicationPort
    const router = new LocalJsonRpcRouter(path, application)
    await expect(router.handle(request('reaction.get', { address: parent, cycleId })))
      .resolves.toMatchObject({ result: { cycleId, status: 'active' } })
    await expect(router.handle(request('reaction.get', { address: parent, cycleId: 'reaction-cycle:missing' })))
      .resolves.toMatchObject({ result: null })
    await expect(router.handle(request('reaction.list', { address: parent })))
      .resolves.toMatchObject({ result: [{ cycleId }] })
    await expect(router.handle(request('reaction.list', { address: parent, status: 'active', limit: 2 })))
      .resolves.toMatchObject({ result: [{ cycleId }] })
    expect(queries).toEqual([{}, { status: 'active', limit: 2 }])
    await expect(router.handle(request('reaction.cancel', {
      address: parent, cycleId, correlationId: 'reaction:rpc-cancel',
    }))).resolves.toMatchObject({ result: { status: 'stop_requested', correlationId: 'reaction:rpc-cancel' } })
    await expect(router.handle(request('reaction.process', { address: parent })))
      .resolves.toMatchObject({ result: { cycleId, waves: [{ wave: 1 }] } })
    await expect(router.handle(request('reaction.process', { address: parent })))
      .resolves.toMatchObject({ result: null })
    await expect(router.handle(request('reaction.process', { address: parent })))
      .resolves.toMatchObject({ result: { cycleId: null, waves: [] } })
    await expect(router.handle(request('reaction.list', { address: parent, status: 1 })))
      .resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await expect(router.handle(request('reaction.list', { address: parent, limit: 1.5 })))
      .resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await router.close()
  })

  it('exposes branch lifecycle, fork, audit, health, and metrics without a listener', async () => {
    const { path, parent, child } = fixture()
    const setup = new WorldStore(path)
    setup.createBranch(parent)
    setup.close()
    const router = new LocalJsonRpcRouter(path)
    await expect(router.handle(request('health.get'))).resolves.toMatchObject({ result: { status: 'ready' } })
    await expect(router.handle(request('branch.status', { address: parent }))).resolves.toMatchObject({ result: { admissionState: 'open' } })
    await expect(router.handle(request('branch.drain', { address: parent, reason: 'maintenance', correlationId: 'rpc:drain' })))
      .resolves.toMatchObject({ result: { admissionState: 'draining' } })
    await expect(router.handle(request('branch.open', { address: parent, reason: 'done', correlationId: 'rpc:open' })))
      .resolves.toMatchObject({ result: { admissionState: 'open' } })
    await expect(router.handle(request('branch.fork', { parent, child, forkSeq: 0 })))
      .resolves.toMatchObject({ result: { status: 'forked', forkSeq: 0 } })
    await expect(router.handle(request('audit.list', { address: parent }))).resolves.toMatchObject({
      result: expect.arrayContaining([expect.objectContaining({ operation: 'branch.admission.changed' })]),
    })
    await expect(router.handle(request('metrics.get'))).resolves.toMatchObject({ result: { branch_forks: 1, branch_transitions: 2 } })
    await expect(router.handle(request('branch.drain', { address: parent, reason: 'archive barrier', correlationId: 'rpc:archive-drain' })))
      .resolves.toMatchObject({ result: { admissionState: 'draining' } })
    await expect(router.handle(request('branch.archive', { address: parent, reason: 'complete', correlationId: 'rpc:archive' })))
      .resolves.toMatchObject({ result: { lifecycleState: 'archived' } })
    await expect(router.handle(request('branch.open', { address: parent, reason: 'illegal', correlationId: 'rpc:illegal' })))
      .resolves.toMatchObject({ error: { errorCode: 'BRANCH_DRAINING' } })

    await expect(router.handle({ ...request('health.get'), jsonrpc: '1.0' as '2.0' })).resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await expect(router.handle(request('unknown'))).resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await expect(router.handle(request('branch.status', { address: { tenantId: 'tenant', worldId: 'world', extra: true } })))
      .resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await expect(router.handle(request('branch.status', { address: null })))
      .resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await expect(router.handle(request('branch.status', { address: [] })))
      .resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await expect(router.handle(request('branch.status', { address: { tenantId: '', worldId: 'world', branchId: 'branch' } })))
      .resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await expect(router.handle(request('branch.fork', { parent, child, forkSeq: 'zero' })))
      .resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    expect(() => router.recoverAcceptedRounds()).toThrow('WorldApplication Port is not configured')
    await router.close()
  })

  it('routes the local game protocol exclusively through WorldApplication', async () => {
    const { directory, path, parent, child } = fixture()
    const sessionPath = join(directory, 'session.sqlite')
    const application = new WorldApplication({ worldPath: path, sessionPath })
    const router = new LocalJsonRpcRouter(path, application)
    const notifications: Array<{ method: string }> = []
    const unsubscribeBrokenNotifications = router.subscribeNotifications(() => { throw new Error('subscriber failed') })
    const unsubscribeNotifications = router.subscribeNotifications(notification => { notifications.push(notification) })
    const spec = {
      schemaVersion: 1,
      address: parent,
      timeMode: 'TURN_DRIVEN',
      roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:room', name: 'Room' }],
      characters: [{ characterId: 'character:player', name: 'Player', locationId: 'location:room' }],
      playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
      plugins: [],
    } as const
    await expect(router.handle(request('world.compile', { spec }))).resolves.toMatchObject({
      result: { manifest: { schemaVersion: 2 }, manifestHash: expect.stringMatching(/^sha256:/) },
    })
    await expect(router.handle(request('world.list'))).resolves.toMatchObject({ result: [] })
    await expect(router.handle(request('world.get', { address: child })))
      .resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await expect(router.handle(request('world.activate', { spec }))).resolves.toMatchObject({ result: { status: 'activated' } })
    await expect(router.handle(request('health.get'))).resolves.toMatchObject({ result: { status: 'ready' } })
    await expect(router.handle(request('health.get'))).resolves.toMatchObject({ result: { status: 'ready' } })
    await expect(router.handle(request('world.list'))).resolves.toMatchObject({
      result: [{ tenantId: parent.tenantId, worldId: parent.worldId, branchCount: 1 }],
    })
    await expect(router.handle(request('world.get', { address: parent }))).resolves.toMatchObject({
      result: { address: parent, manifestHash: expect.stringMatching(/^sha256:/), head: { tick: 0 } },
    })
    await expect(router.handle(request('branch.get', { address: parent }))).resolves.toMatchObject({
      result: { address: parent, control: { runtimePhase: 'active' } },
    })
    await expect(router.handle(request('branch.status', { address: parent })))
      .resolves.toMatchObject({ result: { runtimePhase: 'active', admissionState: 'open' } })
    await expect(router.handle(request('branch.drain', {
      address: parent, reason: 'coordinated maintenance', correlationId: 'rpc:maintenance-enter',
    }))).resolves.toMatchObject({ result: { state: { runtimePhase: 'maintenance' } } })
    await expect(router.handle(request('audit.list', { address: parent }))).resolves.toMatchObject({
      result: expect.arrayContaining([expect.objectContaining({ operation: 'maintenance.entered' })]),
    })
    await expect(router.handle(request('branch.open', {
      address: parent, reason: 'maintenance complete', correlationId: 'rpc:maintenance-exit',
    }))).resolves.toMatchObject({ result: { runtimePhase: 'active', runtimeEpoch: 1 } })
    await expect(router.handle(request('maintenance.enter', {
      address: parent, reason: 'canonical maintenance', correlationId: 'rpc:canonical-maintenance-enter',
    }))).resolves.toMatchObject({ result: { state: { runtimePhase: 'maintenance' } } })
    await expect(router.handle(request('maintenance.exit', {
      address: parent, reason: 'canonical maintenance complete', correlationId: 'rpc:canonical-maintenance-exit',
    }))).resolves.toMatchObject({ result: { runtimePhase: 'active', runtimeEpoch: 2 } })
    await expect(router.handle(request('round.get', { address: parent, idempotencyKey: 'missing' }))).resolves.toMatchObject({ result: null })
    const roundParams = {
      address: parent,
      idempotencyKey: 'rpc-round',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'hello from RPC' } },
      correlationId: 'rpc:round',
    }
    const submitted = await router.handle(request('round.submit', roundParams))
    expect(submitted).toMatchObject({ result: { status: 'queued', roundId: expect.any(String), inboxSeq: 1 } })
    await application.processAcceptedRounds(parent, 'rpc:test-await-worker')
    await expect(router.handle(request('round.get', { address: parent, roundId: (submitted.result as { roundId: string }).roundId })))
      .resolves.toMatchObject({ result: { status: 'committed', result: { status: 'accepted', tick: 1 } } })
    const cancelAccepted = await application.acceptRound(parent, {
      idempotencyKey: 'rpc-cancel', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'cancel' } }, correlationId: 'rpc-cancel',
    })
    await expect(router.handle(request('round.cancel-queued', {
      address: parent, roundId: cancelAccepted.roundId, correlationId: 'rpc-cancel',
    }))).resolves.toMatchObject({ result: { status: 'cancelled' } })
    const cancelByKey = await application.acceptRound(parent, {
      idempotencyKey: 'rpc-cancel-key', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'cancel by key' } }, correlationId: 'rpc-cancel-key',
    })
    expect(cancelByKey.status).toBe('queued')
    await expect(router.handle(request('round.cancel-queued', {
      address: parent, idempotencyKey: 'rpc-cancel-key', correlationId: 'rpc-cancel-key',
    }))).resolves.toMatchObject({ result: { status: 'cancelled' } })
    await expect(router.handle(request('round.submit', {
      address: parent, idempotencyKey: 'rpc-cancel-key', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'cancel by key' } }, correlationId: 'rpc-cancel-key-replay',
    }))).resolves.toMatchObject({ result: { status: 'cancelled' } })
    for (const params of [
      { address: parent },
      { address: parent, idempotencyKey: 'rpc-round', roundId: cancelAccepted.roundId },
    ]) {
      await expect(router.handle(request('round.get', params))).resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
      await expect(router.handle(request('round.cancel-queued', { ...params, correlationId: 'invalid-selector' })))
        .resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    }
    const head = await router.handle(request('world.head', { address: parent }))
    expect(head).toMatchObject({ result: { tick: 1 } })
    await expect(router.handle(request('view.character', {
      address: parent, principalId: 'principal:player', characterId: 'character:player',
    })))
      .resolves.toMatchObject({ result: { characterId: 'character:player', asOfWorldSeq: expect.any(Number) } })
    await expect(router.handle(request('character.view', {
      address: parent, principalId: 'principal:player', characterId: 'character:player',
    }))).resolves.toMatchObject({ result: { characterId: 'character:player' } })
    await expect(router.handle(request('view.character', {
      address: parent, principalId: 'principal:player', characterId: 'character:player',
      asOfWorldSeq: (head.result as { headSeq: number }).headSeq,
    }))).resolves.toMatchObject({ result: { characterId: 'character:player' } })
    await expect(router.handle(request('view.character', {
      address: parent, principalId: 'principal:player', characterId: 'character:npc',
    }))).resolves.toMatchObject({ error: { errorCode: 'UNAUTHORIZED' } })
    await expect(router.handle(request('character.availability.get', {
      address: parent, characterId: 'character:player',
    }))).resolves.toMatchObject({ result: { state: 'ready' } })
    await expect(router.handle(request('character.availability.set', {
      address: parent, characterId: 'character:player', state: 'offline', reason: 'operator pause',
    }))).resolves.toMatchObject({ result: { state: 'offline', reason: 'operator pause' } })
    await expect(router.handle(request('character.availability.set', {
      address: parent, characterId: 'character:player', state: 'ready', reason: null,
    }))).resolves.toMatchObject({ result: { state: 'ready' } })
    await expect(router.handle(request('character.availability.set', {
      address: parent, characterId: 'character:player', state: 'invalid', reason: null,
    }))).resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await expect(router.handle(request('character.availability.set', {
      address: parent, characterId: 'character:player', state: 'ready', reason: 1,
    }))).resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await application.acceptRound(parent, {
      idempotencyKey: 'rpc-explicit-process', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'explicit drain' } }, correlationId: 'rpc:explicit-process',
    })
    await expect(router.handle(request('round.process', {
      address: parent, correlationId: 'rpc:explicit-process',
    }))).resolves.toMatchObject({ result: { processed: 1 } })
    await expect(router.handle(request('round.process', {
      address: parent, correlationId: 'rpc:explicit-process-empty',
    }))).resolves.toMatchObject({ result: { processed: 0 } })
    const fixtureOutbox = new WorldOutbox(path)
    const failingWorker = new SessionOutboxWorker(fixtureOutbox, {
      appendIfAbsent: async () => { throw new Error('RPC recovery fixture') },
    }, parent, 1)
    await expect(failingWorker.runOnce('rpc:dead-letter-fixture')).resolves.toMatchObject({ status: 'dead_letter' })
    fixtureOutbox.close()
    const listed = await router.handle(request('outbox.list', { address: parent }))
    expect(listed).toMatchObject({ result: [{ deliveryId: expect.any(String), lastError: 'RPC recovery fixture' }] })
    const deliveryId = (listed.result as Array<{ deliveryId: string }>)[0]!.deliveryId
    await expect(router.handle(request('outbox.retry', {
      address: parent, deliveryId, correlationId: 'rpc:outbox-retry',
    }))).resolves.toMatchObject({ result: { status: 'retry_scheduled' } })
    await expect(router.handle(request('outbox.drain', { address: parent, correlationId: 'rpc:outbox' })))
      .resolves.toMatchObject({ result: { delivered: 2 } })
    await expect(router.handle(request('outbox.list', { address: parent })))
      .resolves.toMatchObject({ result: [] })
    await expect(router.handle(request('outbox.retry', {
      address: parent, deliveryId: 'delivery:missing', correlationId: 'rpc:outbox-retry',
    }))).resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await expect(router.handle(request('quarantine.explain', { address: parent })))
      .resolves.toMatchObject({ result: { runtimePhase: 'active', failures: [] } })
    await expect(router.handle(request('quarantine.recover', { address: parent, correlationId: 'rpc:recover-illegal' })))
      .resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await expect(router.handle(request('session.render', {
      address: parent, sessionId: 'session:player', sessionEventSeq: 1, locale: 'zh-CN',
    }))).resolves.toMatchObject({ result: { locale: 'zh-CN' } })
    await expect(router.handle(request('session.render', {
      address: parent, sessionId: 'session:player', sessionEventSeq: 1,
    }))).resolves.toMatchObject({ result: { locale: 'en' } })
    const snapshotPath = join(directory, 'snapshot.sqlite')
    await expect(router.handle(request('snapshot.latest', { address: parent, snapshotPath })))
      .resolves.toMatchObject({ result: null })
    const snapshot = await router.handle(request('snapshot.create', {
      address: parent, snapshotPath, correlationId: 'rpc:snapshot',
    }))
    expect(snapshot).toMatchObject({ result: { status: 'created', bundle: { asOfSeq: expect.any(Number) } } })
    await expect(router.handle(request('snapshot.latest', { address: parent, snapshotPath })))
      .resolves.toMatchObject({ result: (snapshot.result as { bundle: unknown }).bundle })
    await expect(router.handle(request('snapshot.list', { address: parent, snapshotPath })))
      .resolves.toMatchObject({ result: [(snapshot.result as { bundle: unknown }).bundle] })

    const backupPath = join(directory, 'world.backup.sqlite')
    const backup = await router.handle(request('backup.create', { targetPath: backupPath, correlationId: 'rpc:backup' }))
    expect(backup).toMatchObject({ result: { format: 'world-sqlite-backup/v1', fileHash: expect.any(String) } })
    await expect(router.handle(request('backup.restore', {
      backupPath,
      targetPath: join(directory, 'restored.sqlite'),
      expectedHash: (backup.result as { fileHash: string }).fileHash,
      correlationId: 'rpc:restore',
    }))).resolves.toMatchObject({ result: { format: 'world-sqlite-backup/v1' } })
    const canonicalBackupPath = join(directory, 'canonical.backup.sqlite')
    const canonicalBackup = await router.handle(request('backup', {
      targetPath: canonicalBackupPath, correlationId: 'rpc:canonical-backup',
    }))
    await expect(router.handle(request('restore', {
      backupPath: canonicalBackupPath,
      targetPath: join(directory, 'canonical-restored.sqlite'),
      expectedHash: (canonicalBackup.result as { fileHash: string }).fileHash,
      correlationId: 'rpc:canonical-restore',
    }))).resolves.toMatchObject({ result: { format: 'world-sqlite-backup/v1' } })

    const portablePath = join(directory, 'world.portable.json')
    await expect(router.handle(request('transfer.export-portable', { exportPath: portablePath, correlationId: 'rpc:portable-export' })))
      .resolves.toMatchObject({ result: { format: 'world-sqlite-backup/v1' } })
    await expect(router.handle(request('transfer.import-portable', {
      exportPath: portablePath, targetPath: join(directory, 'portable-import.sqlite'), correlationId: 'rpc:portable-import',
    }))).resolves.toMatchObject({ result: { format: 'world-sqlite-backup/v1' } })
    const canonicalPortablePath = join(directory, 'canonical.portable.sqlite')
    await expect(router.handle(request('world.export', {
      exportPath: canonicalPortablePath, correlationId: 'rpc:canonical-export',
    }))).resolves.toMatchObject({ result: { format: 'world-sqlite-backup/v1' } })
    await expect(router.handle(request('world.import', {
      exportPath: canonicalPortablePath,
      targetPath: join(directory, 'canonical-portable-import.sqlite'),
      correlationId: 'rpc:canonical-import',
    }))).resolves.toMatchObject({ result: { format: 'world-sqlite-backup/v1' } })

    const authorityPath = join(directory, 'world.authority.json')
    const authority = await router.handle(request('transfer.export-authority', {
      targetPath: authorityPath, correlationId: 'rpc:authority-export',
    }))
    expect(authority).toMatchObject({ result: expect.stringMatching(/^sha256:/) })
    const importedAuthority = await router.handle(request('transfer.import-authority', {
      exportPath: authorityPath, targetPath: join(directory, 'authority-import.sqlite'), correlationId: 'rpc:authority-import',
    }))
    expect(importedAuthority.result).toBe(authority.result)
    await expect(router.handle(request('branch.status', { address: parent }))).resolves.toMatchObject({
      result: { runtimePhase: 'active', admissionState: 'open' },
    })
    const canonicalChild = { ...child, branchId: brandId('branch:canonical-child', 'BranchId') }
    await expect(router.handle(request('branch.fork', {
      parent, child: canonicalChild, reason: 'canonical checkpoint', correlationId: 'rpc:canonical-fork',
    }))).resolves.toMatchObject({ result: { parentState: { admissionState: 'open' } } })
    await expect(router.handle(request('branch.archive', {
      address: canonicalChild, reason: 'canonical complete', correlationId: 'rpc:canonical-archive',
    }))).resolves.toMatchObject({ result: { state: { lifecycleState: 'archived' } } })
    await expect(router.handle(request('branch.fork-at-head', {
      parent, child, reason: 'checkpoint', correlationId: 'rpc:fork-at-head',
    }))).resolves.toMatchObject({ result: { parentState: { admissionState: 'open' } } })
    await expect(router.handle(request('world.list'))).resolves.toMatchObject({
      result: [{ tenantId: parent.tenantId, worldId: parent.worldId, branchCount: 3 }],
    })
    await expect(router.handle(request('branch.archive-coordinated', {
      address: parent, reason: 'complete', correlationId: 'rpc:archive-coordinated',
    }))).resolves.toMatchObject({ result: { state: { lifecycleState: 'archived' } } })
    expect(notifications.map(value => value.method)).toEqual(expect.arrayContaining([
      'health.changed', 'round.committed', 'outbox.dead-lettered', 'presentation.ready',
    ]))
    unsubscribeBrokenNotifications()
    unsubscribeNotifications()

    for (const [method, params] of [
      ['round.submit', { ...roundParams, principalId: 'principal:other', idempotencyKey: 'unauthorized' }],
      ['round.submit', { ...roundParams, action: null }],
      ['round.submit', { ...roundParams, action: [] }],
      ['round.submit', { ...roundParams, action: { actionType: 'speak', parameters: {}, extra: true } }],
      ['round.submit', { ...roundParams, correlationId: 1 }],
      ['round.get', { address: child, idempotencyKey: 1 }],
      ['view.character', { address: child, principalId: 'principal:player', characterId: 'character:player', asOfWorldSeq: -1 }],
      ['view.character', { address: child, principalId: 'principal:player', characterId: 'character:player', asOfWorldSeq: 'latest' }],
      ['session.render', { address: child, sessionId: 'session:player', sessionEventSeq: 1, locale: 'fr' }],
    ] as const) {
      await expect(router.handle(request(method, params as never))).resolves.toMatchObject({ error: { errorCode: expect.any(String) } })
    }
    await router.close()
    await application.close()

    const legacy = new LocalJsonRpcRouter(path)
    await expect(legacy.handle(request('world.head', { address: child })))
      .resolves.toMatchObject({ error: { message: expect.stringContaining('not configured') } })
    await legacy.close()
  })
})

describe('worldctl grammar', () => {
  it('maps local commands to RPC and emits canonical one-line output', async () => {
    expect(parseLocalCli(['health']).method).toBe('health.get')
    expect(parseLocalCli(['metrics']).method).toBe('metrics.get')
    expect(parseLocalCli(['branch', 'status', 'tenant', 'world', 'branch']).method).toBe('branch.status')
    expect(parseLocalCli(['branch', 'audit', 'tenant', 'world', 'branch']).method).toBe('audit.list')
    expect(parseLocalCli(['branch', 'drain', 'tenant', 'world', 'branch', 'planned', 'work']).params).toMatchObject({ reason: 'planned work' })
    expect(parseLocalCli(['branch', 'open', 'tenant', 'world', 'branch', 'done']).method).toBe('branch.open')
    expect(parseLocalCli(['branch', 'archive', 'tenant', 'world', 'branch', 'complete']).method).toBe('branch.archive-coordinated')
    expect(parseLocalCli(['round', 'get', 'tenant', 'world', 'branch', 'round:1']).method).toBe('round.get')
    expect(parseLocalCli(['round', 'submit', 'tenant', 'world', 'branch', 'principal:1', 'round:1', 'speak', '{"text":"hi"}']).params)
      .toMatchObject({ action: { actionType: 'speak', parameters: { text: 'hi' } } })
    expect(parseLocalCli(['world', 'head', 'tenant', 'world', 'branch']).method).toBe('world.head')
    expect(parseLocalCli(['view', 'character', 'tenant', 'world', 'branch', 'principal:1', 'character:1']).method).toBe('view.character')
    expect(parseLocalCli(['view', 'character', 'tenant', 'world', 'branch', 'principal:1', 'character:1', '2']).params)
      .toMatchObject({ principalId: 'principal:1', characterId: 'character:1', asOfWorldSeq: 2 })
    expect(parseLocalCli(['outbox', 'drain', 'tenant', 'world', 'branch']).method).toBe('outbox.drain')
    expect(parseLocalCli(['outbox', 'list', 'tenant', 'world', 'branch']).method).toBe('outbox.list')
    expect(parseLocalCli(['outbox', 'retry', 'tenant', 'world', 'branch', 'delivery:1']).method).toBe('outbox.retry')
    expect(parseLocalCli(['snapshot', 'create', 'tenant', 'world', 'branch', 'snapshot.sqlite']).method).toBe('snapshot.create')
    expect(parseLocalCli(['snapshot', 'latest', 'tenant', 'world', 'branch', 'snapshot.sqlite']).method).toBe('snapshot.latest')
    expect(parseLocalCli(['backup', 'create', 'backup.sqlite']).method).toBe('backup.create')
    expect(parseLocalCli(['transfer', 'export-portable', 'world.json']).params).toMatchObject({ exportPath: 'world.json' })
    expect(parseLocalCli(['transfer', 'export-authority', 'world.json']).params).toMatchObject({ targetPath: 'world.json' })
    expect(() => parseLocalCli(['unknown'])).toThrow('unknown worldctl')
    expect(() => parseLocalCli(['branch'])).toThrow('unknown worldctl')
    expect(() => parseLocalCli(['branch', 'status'])).toThrow('requires tenantId')
    expect(() => parseLocalCli(['branch', 'drain', 'tenant', 'world', 'branch'])).toThrow('requires a reason')
    expect(() => parseLocalCli(['branch', 'unknown', 'tenant', 'world', 'branch'])).toThrow('unknown branch')
    expect(() => parseLocalCli(['round', 'get', 'tenant', 'world', 'branch'])).toThrow('idempotencyKey')
    expect(() => parseLocalCli(['round', 'submit', 'tenant', 'world', 'branch'])).toThrow('requires principalId')
    expect(() => parseLocalCli(['view', 'character', 'tenant', 'world', 'branch'])).toThrow('principalId characterId')
    expect(() => parseLocalCli(['outbox', 'retry', 'tenant', 'world', 'branch'])).toThrow('deliveryId')
    expect(() => parseLocalCli(['snapshot', 'create', 'tenant', 'world', 'branch'])).toThrow('snapshotPath')
    expect(() => parseLocalCli(['backup', 'create'])).toThrow('targetPath')
    expect(() => parseLocalCli(['transfer', 'export-portable'])).toThrow('targetPath')

    const { path, parent } = fixture()
    const store = new WorldStore(path)
    store.createBranch(parent)
    store.close()
    const router = new LocalJsonRpcRouter(path)
    const line = await executeLocalCli(['health'], router)
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0', result: { status: 'ready' } })
    expect(JSON.parse(await executeLocalCli(['unknown'], router))).toMatchObject({
      error: { errorCode: 'INVALID_REQUEST', message: expect.stringContaining('unknown worldctl command') },
    })
    expect(JSON.parse(await executeLocalCli(['health'], router, { busyRetryTimeoutMs: -1 }))).toMatchObject({
      error: { message: expect.stringContaining('busyRetryTimeoutMs') },
    })
    expect(JSON.parse(await executeLocalCli(['health'], router, { busyRetryDelayMs: 0 }))).toMatchObject({
      error: { message: expect.stringContaining('busyRetryDelayMs') },
    })
    expect(router.metrics.snapshot()).toMatchObject({ rpc_requests: 4, rpc_errors: 3 })
    await router.close()
  })

  it('implements --wait only as client-side round.get polling', async () => {
    const { directory, path, parent } = fixture()
    const application = new WorldApplication({ worldPath: path, sessionPath: join(directory, 'wait-session.sqlite') })
    application.activateSpec({
      schemaVersion: 1, address: parent, timeMode: 'TURN_DRIVEN', roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:wait', name: 'Wait' }],
      characters: [{ characterId: 'character:wait', name: 'Wait', locationId: 'location:wait' }],
      playerBindings: [{ principalId: 'principal:wait', characterId: 'character:wait', sessionId: 'session:wait' }],
      plugins: [],
    })
    const router = new LocalJsonRpcRouter(path, application)
    const line = await executeLocalCli([
      'round', 'submit', parent.tenantId, parent.worldId, parent.branchId,
      'principal:wait', 'round:wait', 'speak', '{"text":"wait"}', '--wait',
    ], router)
    expect(JSON.parse(line)).toMatchObject({ result: { status: 'committed', result: { status: 'accepted', tick: 1 } } })
    expect(JSON.parse(await executeLocalCli(['health'], router, { roundWaitTimeoutMs: -1 }))).toMatchObject({
      error: { message: expect.stringContaining('roundWaitTimeoutMs') },
    })
    expect(JSON.parse(await executeLocalCli(['health'], router, { roundWaitDelayMs: 0 }))).toMatchObject({
      error: { message: expect.stringContaining('roundWaitDelayMs') },
    })
    await router.close()
    await application.close()
  })

  it('emits branch.quarantined only as an ephemeral query-recoverable notification', async () => {
    const { directory, path, parent } = fixture()
    const application = new WorldApplication({ worldPath: path, sessionPath: join(directory, 'session.sqlite') })
    application.activateSpec({
      schemaVersion: 1, address: parent, timeMode: 'TURN_DRIVEN', roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:q', name: 'Q' }],
      characters: [{ characterId: 'character:q', name: 'Q', locationId: 'location:q' }],
      playerBindings: [{ principalId: 'principal:q', characterId: 'character:q', sessionId: 'session:q' }],
      plugins: [],
    })
    const router = new LocalJsonRpcRouter(path, application)
    const notifications: string[] = []
    router.subscribeNotifications(notification => { notifications.push(notification.method) })
    const quarantine = new BranchQuarantineService(path)
    quarantine.quarantine({
      address: parent,
      error: createErrorEnvelope({
        errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: 'notification fixture',
        retryable: false, correlationId: 'notification:quarantine', address: parent,
      }),
      source: 'operations.notification.test',
    })
    quarantine.close()
    await expect(router.handle(request('quarantine.explain', { address: parent })))
      .resolves.toMatchObject({ result: { runtimePhase: 'quarantined' } })
    expect(notifications).toEqual(['branch.quarantined'])
    await router.close()
    await application.close()
  })

  it('fails closed when --wait has no round identity or reaches its deadline', async () => {
    const noIdentity = {
      handle: async () => ({ jsonrpc: '2.0', id: 'cli', result: { status: 'queued' } }),
      invalidRequest: (id: string | number | null, error: unknown) => ({ jsonrpc: '2.0', id, error: { message: String(error) } }),
    } as unknown as LocalJsonRpcRouter
    await expect(executeLocalCli([
      'round', 'submit', 'tenant', 'world', 'branch', 'principal', 'key', 'speak', '{}', '--wait',
    ], noIdentity)).resolves.toContain('no roundId')

    let clock = 0
    let polls = 0
    const neverCompletes = {
      handle: async (rpcRequest: LocalJsonRpcRequest): Promise<LocalJsonRpcResponse> => {
        if (rpcRequest.method === 'round.submit') {
          return { jsonrpc: '2.0', id: rpcRequest.id, result: { status: 'queued', roundId: 'round:waiting' } }
        }
        polls += 1
        return { jsonrpc: '2.0', id: rpcRequest.id, result: { status: polls === 1 ? 'processing' : 'queued' } }
      },
      invalidRequest: (id: string | number | null, error: unknown) => ({ jsonrpc: '2.0', id, error: { message: String(error) } }),
    } as unknown as LocalJsonRpcRouter
    await expect(executeLocalCli([
      'round', 'submit', 'tenant', 'world', 'branch', 'principal', 'key', 'speak', '{}', '--wait',
    ], neverCompletes, {
      roundWaitTimeoutMs: 1,
      roundWaitDelayMs: 1,
      now: () => clock,
      wait: async delay => { clock += delay },
    })).resolves.toContain('timed out')
    expect(polls).toBe(2)

    const missingStatus = {
      handle: async (rpcRequest: LocalJsonRpcRequest): Promise<LocalJsonRpcResponse> => rpcRequest.method === 'round.submit'
        ? { jsonrpc: '2.0', id: rpcRequest.id, result: { status: 'queued', roundId: 'round:missing' } }
        : { jsonrpc: '2.0', id: rpcRequest.id, result: null },
      invalidRequest: (id: string | number | null, error: unknown) => ({ jsonrpc: '2.0', id, error: { message: String(error) } }),
    } as unknown as LocalJsonRpcRouter
    await expect(executeLocalCli([
      'round', 'submit', 'tenant', 'world', 'branch', 'principal', 'key', 'speak', '{}', '--wait',
    ], missingStatus)).resolves.toContain('no durable Round')

    const failedPoll = {
      handle: async (rpcRequest: LocalJsonRpcRequest): Promise<LocalJsonRpcResponse> => rpcRequest.method === 'round.submit'
        ? { jsonrpc: '2.0', id: rpcRequest.id, result: { status: 'queued', roundId: 'round:failed-poll' } }
        : { jsonrpc: '2.0', id: rpcRequest.id, error: { errorCode: 'BRANCH_QUARANTINED' } },
      invalidRequest: (id: string | number | null, error: unknown) => ({ jsonrpc: '2.0', id, error: { message: String(error) } }),
    } as unknown as LocalJsonRpcRouter
    await expect(executeLocalCli([
      'round', 'submit', 'tenant', 'world', 'branch', 'principal', 'key', 'speak', '{}', '--wait',
    ], failedPoll)).resolves.toContain('BRANCH_QUARANTINED')

    for (const malformed of [[], 'not-a-status']) {
      const malformedPoll = {
        handle: async (rpcRequest: LocalJsonRpcRequest): Promise<LocalJsonRpcResponse> => rpcRequest.method === 'round.submit'
          ? { jsonrpc: '2.0', id: rpcRequest.id, result: { status: 'queued', roundId: 'round:malformed-poll' } }
          : { jsonrpc: '2.0', id: rpcRequest.id, result: malformed as never },
        invalidRequest: (id: string | number | null, error: unknown) => ({ jsonrpc: '2.0', id, error: { message: String(error) } }),
      } as unknown as LocalJsonRpcRouter
      const malformedLine = await executeLocalCli([
        'round', 'submit', 'tenant', 'world', 'branch', 'principal', 'key', 'speak', '{}', '--wait',
      ], malformedPoll)
      expect(JSON.parse(malformedLine).result).toEqual(malformed)
    }
  })

  it('deduplicates concurrent local Round workers and contains worker failures', async () => {
    const { directory, path, parent } = fixture()
    let releaseWorker!: () => void
    let workerCalls = 0
    class DeferredWorldApplication extends WorldApplication {
      override processAcceptedRounds(): Promise<number> {
        workerCalls += 1
        if (workerCalls > 1) return Promise.resolve(0)
        return new Promise(resolve => { releaseWorker = () => resolve(0) })
      }
    }
    const application = new DeferredWorldApplication({ worldPath: path, sessionPath: join(directory, 'deferred-session.sqlite') })
    application.activateSpec({
      schemaVersion: 1, address: parent, timeMode: 'TURN_DRIVEN', roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:worker', name: 'Worker' }],
      characters: [{ characterId: 'character:worker', name: 'Worker', locationId: 'location:worker' }],
      playerBindings: [{ principalId: 'principal:worker', characterId: 'character:worker', sessionId: 'session:worker' }],
      plugins: [],
    })
    const router = new LocalJsonRpcRouter(path, application)
    const base = {
      address: parent, principalId: 'principal:worker', action: { actionType: 'speak', parameters: {} },
    }
    await router.handle(request('round.submit', { ...base, idempotencyKey: 'worker:one', correlationId: 'worker:one' }))
    await router.handle(request('round.submit', { ...base, idempotencyKey: 'worker:two', correlationId: 'worker:two' }))
    releaseWorker()
    await router.close()
    expect(workerCalls).toBe(2)
    await application.close()

    const directFixture = fixture()
    class DirectProcessWorldApplication extends WorldApplication {
      override processAcceptedRounds(): Promise<number> { return Promise.resolve(1) }
    }
    const directApplication = new DirectProcessWorldApplication({
      worldPath: directFixture.path, sessionPath: join(directFixture.directory, 'direct-session.sqlite'),
    })
    const directRouter = new LocalJsonRpcRouter(directFixture.path, directApplication)
    const directNotifications: string[] = []
    directRouter.subscribeNotifications(notification => { directNotifications.push(notification.method) })
    await expect(directRouter.handle(request('round.process', {
      address: directFixture.parent, correlationId: 'round:direct-process',
    }))).resolves.toMatchObject({ result: { processed: 1 } })
    expect(directNotifications).toContain('round.committed')
    await directRouter.close()
    await directApplication.close()

    const failedFixture = fixture()
    class FailingWorldApplication extends WorldApplication {
      override async processAcceptedRounds(): Promise<number> {
        throw new Error('contained worker failure')
      }
    }
    const failing = new FailingWorldApplication({
      worldPath: failedFixture.path, sessionPath: join(failedFixture.directory, 'failed-session.sqlite'),
    })
    failing.activateSpec({
      schemaVersion: 1, address: failedFixture.parent, timeMode: 'TURN_DRIVEN', roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:failed', name: 'Failed' }],
      characters: [{ characterId: 'character:failed', name: 'Failed', locationId: 'location:failed' }],
      playerBindings: [{ principalId: 'principal:failed', characterId: 'character:failed', sessionId: 'session:failed' }],
      plugins: [],
    })
    const failingRouter = new LocalJsonRpcRouter(failedFixture.path, failing)
    await expect(failingRouter.handle(request('round.submit', {
      address: failedFixture.parent, idempotencyKey: 'worker:failed', principalId: 'principal:failed',
      action: { actionType: 'speak', parameters: {} }, correlationId: 'worker:failed',
    }))).resolves.toMatchObject({ result: { status: 'queued' } })
    await failingRouter.close()
    expect(failingRouter.metrics.snapshot()).toMatchObject({ round_worker_failures: 1 })
    const failureAudit = new BranchAdministration(failedFixture.path)
    expect(failureAudit.readAudit(failedFixture.parent)).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'round.worker.failed', details: { errorType: 'object', message: 'Error: contained worker failure' } }),
    ]))
    failureAudit.close()
    await failing.close()

    const typedFixture = fixture()
    class TypedFailingWorldApplication extends WorldApplication {
      override async processAcceptedRounds(): Promise<number> {
        throw new WorldError(createErrorEnvelope({
          errorCode: 'WORLDSTORE_BUSY', category: 'runtime', message: 'typed worker failure', retryable: true,
          correlationId: 'worker:typed', address: typedFixture.parent,
        }))
      }
    }
    const typedFailing = new TypedFailingWorldApplication({
      worldPath: typedFixture.path, sessionPath: join(typedFixture.directory, 'typed-failed-session.sqlite'),
    })
    typedFailing.activateSpec({
      schemaVersion: 1, address: typedFixture.parent, timeMode: 'TURN_DRIVEN', roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:typed', name: 'Typed' }],
      characters: [{ characterId: 'character:typed', name: 'Typed', locationId: 'location:typed' }],
      playerBindings: [{ principalId: 'principal:typed', characterId: 'character:typed', sessionId: 'session:typed' }],
      plugins: [],
    })
    const typedRouter = new LocalJsonRpcRouter(typedFixture.path, typedFailing)
    await typedRouter.handle(request('round.submit', {
      address: typedFixture.parent, idempotencyKey: 'worker:typed', principalId: 'principal:typed',
      action: { actionType: 'speak', parameters: {} }, correlationId: 'worker:typed',
    }))
    await typedRouter.close()
    const typedAudit = new BranchAdministration(typedFixture.path)
    expect(typedAudit.readAudit(typedFixture.parent)).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'round.worker.failed', details: { errorCode: 'WORLDSTORE_BUSY', errorId: expect.any(String) } }),
    ]))
    typedAudit.close()
    await typedFailing.close()

    const retryFixture = fixture()
    let retryCalls = 0
    class RetryOnceWorldApplication extends WorldApplication {
      override processAcceptedRounds(address: WorldAddress, correlationId: string): Promise<number> {
        retryCalls += 1
        if (retryCalls === 1) {
          return Promise.reject(new WorldError(createErrorEnvelope({
            errorCode: 'WORLDSTORE_BUSY', category: 'runtime', message: 'transient startup lease', retryable: true,
            correlationId: 'worker:retry-once', address,
          })))
        }
        return super.processAcceptedRounds(address, correlationId)
      }
    }
    const retryingApplication = new RetryOnceWorldApplication({
      worldPath: retryFixture.path, sessionPath: join(retryFixture.directory, 'retry-session.sqlite'),
    })
    retryingApplication.activateSpec({
      schemaVersion: 1, address: retryFixture.parent, timeMode: 'TURN_DRIVEN', roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:retry', name: 'Retry' }],
      characters: [{ characterId: 'character:retry', name: 'Retry', locationId: 'location:retry' }],
      playerBindings: [{ principalId: 'principal:retry', characterId: 'character:retry', sessionId: 'session:retry' }],
      plugins: [],
    })
    const retryRouter = new LocalJsonRpcRouter(retryFixture.path, retryingApplication)
    const retryAccepted = await retryRouter.handle(request('round.submit', {
      address: retryFixture.parent, idempotencyKey: 'worker:retry', principalId: 'principal:retry',
      action: { actionType: 'speak', parameters: {} }, correlationId: 'worker:retry',
    }))
    await new Promise(resolve => setTimeout(resolve, 150))
    await retryRouter.close()
    expect(retryCalls).toBe(2)
    await expect(retryingApplication.roundStatus(retryFixture.parent, {
      roundId: brandId((retryAccepted.result as { roundId: string }).roundId, 'InteractionRoundId'),
    })).resolves.toMatchObject({ status: 'committed' })
    await retryingApplication.close()

    const orphan = fixture()
    const orphanApplication = new WorldApplication({
      worldPath: orphan.path, sessionPath: join(orphan.directory, 'orphan-session.sqlite'), leaseTtlMs: 1_000,
    })
    orphanApplication.activateSpec({
      schemaVersion: 1, address: orphan.parent, timeMode: 'TURN_DRIVEN', roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:orphan', name: 'Orphan' }],
      characters: [{ characterId: 'character:orphan', name: 'Orphan', locationId: 'location:orphan' }],
      playerBindings: [{ principalId: 'principal:orphan', characterId: 'character:orphan', sessionId: 'session:orphan' }],
      plugins: [],
    })
    const accepted = await orphanApplication.acceptRound(orphan.parent, {
      idempotencyKey: 'worker:orphan', principalId: 'principal:orphan',
      action: { actionType: 'speak', parameters: { text: 'recover me' } }, correlationId: 'worker:orphan',
    })
    const orphanLeases = new WriterLeaseService(orphan.path, () => 0)
    const staleLease = orphanLeases.acquire(orphan.parent, 'crashed:worker', 1)
    const orphanInbox = new RoundInbox(orphan.path, () => 0)
    expect(orphanInbox.claimNext(orphan.parent, staleLease.ownerId, staleLease.fencingToken)).toMatchObject({ inboxSeq: accepted.inboxSeq })
    orphanInbox.close()
    orphanLeases.close()
    const recoveryRouter = new LocalJsonRpcRouter(orphan.path, orphanApplication)
    expect(recoveryRouter.recoverAcceptedRounds('worker:startup')).toBe(1)
    await recoveryRouter.close()
    await expect(orphanApplication.roundStatus(orphan.parent, { roundId: accepted.roundId })).resolves.toMatchObject({ status: 'committed' })
    await orphanApplication.close()
  })

  it('retries a busy writer only within the configured CLI deadline', async () => {
    let calls = 0
    let clock = 0
    const response = (busy: boolean): LocalJsonRpcResponse => busy
      ? { jsonrpc: '2.0', id: 'cli', error: { errorCode: 'WORLDSTORE_BUSY' } }
      : { jsonrpc: '2.0', id: 'cli', result: { status: 'ready' } }
    const retrying = {
      handle: async () => response(calls++ === 0),
      invalidRequest: () => { throw new Error('unexpected parse failure') },
    } as unknown as LocalJsonRpcRouter
    const line = await executeLocalCli(['health'], retrying, {
      busyRetryTimeoutMs: 10,
      busyRetryDelayMs: 4,
      now: () => clock,
      wait: async delay => { clock += delay },
    })
    expect(JSON.parse(line)).toMatchObject({ result: { status: 'ready' } })
    expect(calls).toBe(2)

    const exhausted = {
      handle: async () => response(true),
      invalidRequest: () => { throw new Error('unexpected parse failure') },
    } as unknown as LocalJsonRpcRouter
    expect(JSON.parse(await executeLocalCli(['health'], exhausted))).toMatchObject({
      error: { errorCode: 'WORLDSTORE_BUSY' },
    })

    calls = 0
    const defaultWait = {
      handle: async () => response(calls++ === 0),
      invalidRequest: () => { throw new Error('unexpected parse failure') },
    } as unknown as LocalJsonRpcRouter
    await expect(executeLocalCli(['health'], defaultWait, { busyRetryTimeoutMs: 5, busyRetryDelayMs: 1 }))
      .resolves.toContain('"status":"ready"')
  })

  it('recovers active Reaction Cycles on startup and drains them via the reaction worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcw-op-reaction-recovery-'))
    directories.push(dir)
    const worldPath = join(dir, 'world.sqlite')
    const sessionPath = join(dir, 'session.sqlite')
    const memoryPath = join(dir, 'memory.sqlite')

    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }

    const compiled = v5Manifest()
    const application = new WorldApplication({
      worldPath, sessionPath, memoryPath, modelBudgetTokens: 64, leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(compiled)
    await application.submit(ADDRESS, {
      idempotencyKey: 'recovery:e2e', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'Hello' } },
      correlationId: 'recovery:e2e',
    })
    const probe1 = new WorldStore(worldPath)
    const cyclesBefore = probe1.listReactionCycles(ADDRESS)
    probe1.close()
    expect(cyclesBefore.length).toBe(1)
    expect(cyclesBefore[0]!.status).toBe('active')
    await application.close()

    const recovered = new WorldApplication({
      worldPath, sessionPath, memoryPath, modelBudgetTokens: 64, leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    recovered.activate(compiled)
    const router = new LocalJsonRpcRouter(worldPath, recovered)
    try {
      const notifications: string[] = []
      router.subscribeNotifications(notification => { notifications.push(notification.method) })
      const count = router.recoverAcceptedRounds('recovery:startup')
      expect(count).toBeGreaterThanOrEqual(1)
      await new Promise(resolve => setTimeout(resolve, 500))
      const probe2 = new WorldStore(worldPath)
      const cyclesAfter = probe2.listReactionCycles(ADDRESS)
      probe2.close()
      expect(cyclesAfter[0]!.status).toBe('terminal')
      expect(notifications).toEqual(expect.arrayContaining([
        'reaction.started', 'reaction.round_committed', 'reaction.completed',
      ]))
    } finally {
      await router.close()
      await recovered.close()
    }
  })

  it('records reaction worker failures and coalesces concurrent wake-ups', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcw-op-reaction-fault-'))
    directories.push(dir)
    const worldPath = join(dir, 'world.sqlite')
    const sessionPath = join(dir, 'session.sqlite')
    const memoryPath = join(dir, 'memory.sqlite')

    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }

    let faultHits = 0
    let faultThrown: () => void
    const faultPromise = new Promise<void>(resolve => { faultThrown = resolve })
    const faultInjector: FaultInjector = {
      hit(point) {
        if (point === 'reaction.after-wave-settle' && faultHits++ === 0) {
          faultThrown()
          throw new WorldError(createErrorEnvelope({
            errorCode: 'WORLD_COMMIT_FAILED', category: 'runtime',
            message: 'test fault injection', retryable: true, correlationId: 'reaction-fault',
          }))
        }
      },
    }

    const compiled = v5Manifest()
    const application = new WorldApplication({
      worldPath, sessionPath, memoryPath, modelBudgetTokens: 64, leaseTtlMs: 30_000, faultInjector,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(compiled)
    const router = new LocalJsonRpcRouter(worldPath, application)
    try {
      await router.handle({
        jsonrpc: '2.0', id: 'fault:submit', method: 'round.submit',
        params: {
          address: ADDRESS, idempotencyKey: 'fault:e2e', principalId: 'principal:player',
          action: { actionType: 'speak', parameters: { text: 'trigger fault' } },
          correlationId: 'fault:e2e',
        },
      })
      await new Promise(resolve => setTimeout(resolve, 200))
      await faultPromise
      const recovered = router.recoverAcceptedRounds('fault:coalesced-wake')
      expect(recovered).toBeGreaterThanOrEqual(1)
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(router.metrics.snapshot().reaction_worker_failures).toBeGreaterThanOrEqual(1)
      const auditDb = new DatabaseSync(worldPath)
      try {
        const events = auditDb.prepare(`SELECT operation, correlation_id FROM branch_audit_events WHERE operation = 'reaction.worker.failed'`).all()
        expect(events.length).toBeGreaterThanOrEqual(1)
      } finally {
        auditDb.close()
      }
    } finally {
      await router.close()
      await application.close()
    }
  }, 60000)

  it('emits reaction notifications for a multi-wave cycle via the auto worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcw-op-reaction-notify-'))
    directories.push(dir)
    const worldPath = join(dir, 'world.sqlite')
    const sessionPath = join(dir, 'session.sqlite')
    const memoryPath = join(dir, 'memory.sqlite')

    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')

    function waveProvider(actorId: CharacterId, wavesToAct: Set<number>): ReactionAgentProvider {
      return {
        async propose(context: ReactionProposalContext): Promise<SubmitActionsV2> {
          if (wavesToAct.has(context.origin.wave)) {
            return {
              schemaVersion: 2,
              decision: 'act',
              actions: [{
                actionId: `action:${actorId}:wave${context.origin.wave}`,
                actorId,
                actionType: 'speak',
                actionVersion: 1,
                parameters: { text: `wave ${context.origin.wave}` },
              }],
            }
          }
          return { schemaVersion: 2, decision: 'abstain', actions: [] }
        },
      }
    }

    function waveBinding(actorId: CharacterId, wavesToAct: Set<number>): ReactionParticipantBinding {
      return {
        participantId: `agent:${actorId.split(':')[1]}`,
        role: 'agent',
        actorId,
        allowedActionTypes: ['speak'],
        priority: 0,
        estimatedTokens: 2,
        timeoutMs: 5_000,
        provider: waveProvider(actorId, wavesToAct),
      }
    }

    const compiled = v5Manifest()
    const application = new WorldApplication({
      worldPath, sessionPath, memoryPath, modelBudgetTokens: 64, leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [
        waveBinding(alice, new Set([1])),
        waveBinding(bob, new Set([2])),
      ],
    })
    application.activate(compiled)
    const router = new LocalJsonRpcRouter(worldPath, application)
    try {
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
      router.subscribeNotifications(notification => {
        notifications.push({ method: notification.method, params: notification.params as Record<string, unknown> })
      })
      await router.handle({
        jsonrpc: '2.0', id: 'notify:submit', method: 'round.submit',
        params: {
          address: ADDRESS, idempotencyKey: 'notify:e2e', principalId: 'principal:player',
          action: { actionType: 'speak', parameters: { text: 'trigger reaction' } },
          correlationId: 'notify:e2e',
        },
      })
      await new Promise(resolve => setTimeout(resolve, 1000))

      const methods = notifications.map(value => value.method)
      expect(methods).toContain('reaction.started')
      expect(methods.filter(value => value === 'reaction.round_committed').length).toBeGreaterThanOrEqual(2)
      expect(methods).toContain('reaction.completed')

      const started = notifications.find(value => value.method === 'reaction.started')!
      expect(started.params).toMatchObject({
        address: ADDRESS, cycleId: expect.any(String), rootRoundId: expect.any(String),
      })
      const roundCommitted = notifications.filter(value => value.method === 'reaction.round_committed')
      expect(roundCommitted.length).toBeGreaterThanOrEqual(2)
      const waves = roundCommitted.map(value => (value.params as Record<string, unknown>).wave as number)
      expect(waves).toContain(1)
      expect(waves).toContain(2)
      const allSameCycle = roundCommitted.every(value => value.params.cycleId === started.params.cycleId)
      expect(allSameCycle).toBe(true)
      const allSameRoot = roundCommitted.every(value => value.params.rootRoundId === started.params.rootRoundId)
      expect(allSameRoot).toBe(true)

      const completed = notifications.find(value => value.method === 'reaction.completed')!
      expect(completed.params).toMatchObject({
        address: ADDRESS, cycleId: started.params.cycleId,
        terminalReason: expect.any(String), rootRoundId: started.params.rootRoundId,
      })
    } finally {
      await router.close()
      await application.close()
    }
  }, 30000)

  it('isolates broken notification subscribers from the Reaction Cycle outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcw-op-reaction-notify-broken-'))
    directories.push(dir)
    const worldPath = join(dir, 'world.sqlite')
    const sessionPath = join(dir, 'session.sqlite')
    const memoryPath = join(dir, 'memory.sqlite')

    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }

    const compiled = v5Manifest()
    const application = new WorldApplication({
      worldPath, sessionPath, memoryPath, modelBudgetTokens: 64, leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(compiled)
    const router = new LocalJsonRpcRouter(worldPath, application)
    try {
      router.subscribeNotifications(() => { throw new Error('broken subscriber') })
      const notifications: string[] = []
      router.subscribeNotifications(notification => { notifications.push(notification.method) })

      await router.handle({
        jsonrpc: '2.0', id: 'notify-broken:submit', method: 'round.submit',
        params: {
          address: ADDRESS, idempotencyKey: 'notify:broken', principalId: 'principal:player',
          action: { actionType: 'speak', parameters: { text: 'trigger reaction' } },
          correlationId: 'notify:broken',
        },
      })
      await new Promise(resolve => setTimeout(resolve, 500))

      const probe = new WorldStore(worldPath)
      try {
        const cycles = probe.listReactionCycles(ADDRESS)
        expect(cycles[0]!.status).toBe('terminal')
      } finally {
        probe.close()
      }
      expect(notifications).toContain('reaction.started')
      expect(notifications).toContain('reaction.completed')
    } finally {
      await router.close()
      await application.close()
    }
  }, 30000)

  it('projects reaction notifications from the explicit reaction.process handler', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcw-op-reaction-notify-process-'))
    directories.push(dir)
    const worldPath = join(dir, 'world.sqlite')
    const sessionPath = join(dir, 'session.sqlite')
    const memoryPath = join(dir, 'memory.sqlite')

    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }

    const compiled = v5Manifest()
    const seed = new WorldApplication({
      worldPath, sessionPath, memoryPath, modelBudgetTokens: 64, leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    seed.activate(compiled)
    await seed.submit(ADDRESS, {
      idempotencyKey: 'notify-process:seed', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'seed' } },
      correlationId: 'notify-process:seed',
    })
    await seed.close()

    const application = new WorldApplication({
      worldPath, sessionPath, memoryPath, modelBudgetTokens: 64, leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(compiled)
    const router = new LocalJsonRpcRouter(worldPath, application)
    try {
      const notifications: string[] = []
      router.subscribeNotifications(notification => { notifications.push(notification.method) })
      await expect(router.handle(request('reaction.process', { address: ADDRESS })))
        .resolves.toMatchObject({ result: expect.anything() })
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(notifications).toContain('reaction.started')
      expect(notifications).toContain('reaction.completed')
    } finally {
      await router.close()
      await application.close()
    }
  }, 30000)

  it('projects each durable Reaction transition at most once per router while allowing later waves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcw-op-reaction-notify-dedup-'))
    directories.push(dir)
    const worldPath = join(dir, 'world.sqlite')
    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const compiled = v5Manifest()
    const application = new WorldApplication({
      worldPath,
      sessionPath: join(dir, 'session.sqlite'),
      memoryPath: join(dir, 'memory.sqlite'),
      modelBudgetTokens: 64,
      leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(compiled)
    await application.submit(ADDRESS, {
      idempotencyKey: 'notify-dedup:seed', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'seed' } }, correlationId: 'notify-dedup:seed',
    })
    const probe = new WorldStore(worldPath)
    const cycleId = probe.listReactionCycles(ADDRESS)[0]!.cycleId
    probe.close()
    let calls = 0
    const port = {
      async processReactionCycles(address: WorldAddress) {
        calls += 1
        if (calls === 1) return { cycleId, waves: [] }
        if (calls === 2) return application.processReactionCycles(address)
        return { cycleId, waves: [] }
      },
    } as unknown as WorldApplicationPort
    const router = new LocalJsonRpcRouter(worldPath, port)
    const notifications: string[] = []
    router.subscribeNotifications(notification => { notifications.push(notification.method) })
    try {
      const processRequest = request('reaction.process', { address: ADDRESS })
      await router.handle(processRequest)
      expect(notifications).toEqual(['reaction.started'])
      await router.handle(processRequest)
      expect(notifications).toEqual([
        'reaction.started', 'reaction.round_committed', 'reaction.completed',
      ])
      await router.handle(processRequest)
      expect(notifications).toEqual([
        'reaction.started', 'reaction.round_committed', 'reaction.completed',
      ])
    } finally {
      await router.close()
      await application.close()
    }
  })

  it('does not project an old terminal Cycle when a later Root creates no Cycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcw-op-reaction-notify-old-'))
    directories.push(dir)
    const worldPath = join(dir, 'world.sqlite')
    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const compiled = v5Manifest()
    const seed = new WorldApplication({
      worldPath,
      sessionPath: join(dir, 'session.sqlite'),
      memoryPath: join(dir, 'memory.sqlite'),
      modelBudgetTokens: 64,
      leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    seed.activate(compiled)
    await seed.submit(ADDRESS, {
      idempotencyKey: 'old-cycle:seed', principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'seed' } }, correlationId: 'old-cycle:seed',
    })
    await seed.processReactionCycles(ADDRESS)
    await seed.close()

    const application = {
      async acceptRound() { return { status: 'queued' } },
      async processAcceptedRounds() { return 1 },
    } as unknown as WorldApplicationPort
    const router = new LocalJsonRpcRouter(worldPath, application)
    const notifications: string[] = []
    router.subscribeNotifications(notification => { notifications.push(notification.method) })
    try {
      await router.handle(request('round.submit', {
        address: ADDRESS,
        idempotencyKey: 'old-cycle:no-new-cycle',
        principalId: 'principal:player',
        action: { actionType: 'speak', parameters: { text: 'no new Cycle in mocked worker' } },
        correlationId: 'old-cycle:no-new-cycle',
      }))
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(notifications).toContain('round.committed')
      expect(notifications.some(method => method.startsWith('reaction.'))).toBe(false)
    } finally {
      await router.close()
    }
  })

  it('coalesces startup Reaction wakes and retries a typed transient worker failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcw-op-reaction-retry-'))
    directories.push(dir)
    const worldPath = join(dir, 'world.sqlite')
    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const compiled = v5Manifest()
    const seed = new WorldApplication({
      worldPath,
      sessionPath: join(dir, 'session.sqlite'),
      memoryPath: join(dir, 'memory.sqlite'),
      modelBudgetTokens: 64,
      leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    seed.activate(compiled)
    await seed.submit(ADDRESS, {
      idempotencyKey: 'retry:seed',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'seed active Cycle' } },
      correlationId: 'retry:seed',
    })
    await seed.close()

    let releaseFirst!: () => void
    const firstStarted = new Promise<void>(resolve => { releaseFirst = resolve })
    let calls = 0
    const application = {
      async processReactionCycles(address: WorldAddress) {
        calls += 1
        if (calls === 1) {
          await firstStarted
          throw new WorldError(createErrorEnvelope({
            errorCode: 'WORLDSTORE_BUSY',
            category: 'runtime',
            message: 'retry typed Reaction worker failure',
            retryable: true,
            correlationId: 'retry:typed',
            address,
          }))
        }
        return { cycleId: null, terminalReason: null, waves: [] }
      },
    } as unknown as WorldApplicationPort
    const router = new LocalJsonRpcRouter(worldPath, application)
    try {
      expect(router.recoverAcceptedRounds('retry:first')).toBeGreaterThanOrEqual(1)
      expect(router.recoverAcceptedRounds('retry:coalesced')).toBeGreaterThanOrEqual(1)
      releaseFirst()
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(calls).toBe(2)
      expect(router.metrics.snapshot().reaction_worker_failures).toBe(1)
      const auditDb = new DatabaseSync(worldPath)
      try {
        expect(auditDb.prepare(`SELECT details_json FROM branch_audit_events WHERE operation = 'reaction.worker.failed'`).get())
          .toMatchObject({ details_json: expect.stringContaining('WORLDSTORE_BUSY') })
      } finally {
        auditDb.close()
      }
    } finally {
      await router.close()
    }
  })

  it('enriches reaction outbox payloads with the full causal chain for Presentation rendering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcw-op-reaction-causal-'))
    directories.push(dir)
    const worldPath = join(dir, 'world.sqlite')
    const sessionPath = join(dir, 'session.sqlite')
    const memoryPath = join(dir, 'memory.sqlite')

    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')

    function waveProvider(actorId: CharacterId, wavesToAct: Set<number>): ReactionAgentProvider {
      return {
        async propose(context: ReactionProposalContext): Promise<SubmitActionsV2> {
          if (wavesToAct.has(context.origin.wave)) {
            return {
              schemaVersion: 2,
              decision: 'act',
              actions: [{
                actionId: `action:${actorId}:wave${context.origin.wave}`,
                actorId,
                actionType: 'speak',
                actionVersion: 1,
                parameters: { text: `wave ${context.origin.wave}` },
              }],
            }
          }
          return { schemaVersion: 2, decision: 'abstain', actions: [] }
        },
      }
    }

    function waveBinding(actorId: CharacterId, wavesToAct: Set<number>): ReactionParticipantBinding {
      return {
        participantId: `agent:${actorId.split(':')[1]}`,
        role: 'agent',
        actorId,
        allowedActionTypes: ['speak'],
        priority: 0,
        estimatedTokens: 2,
        timeoutMs: 5_000,
        provider: waveProvider(actorId, wavesToAct),
      }
    }

    const compiled = v5Manifest()
    const application = new WorldApplication({
      worldPath, sessionPath, memoryPath, modelBudgetTokens: 64, leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [
        waveBinding(alice, new Set([1])),
        waveBinding(bob, new Set([2])),
      ],
    })
    application.activate(compiled)
    const router = new LocalJsonRpcRouter(worldPath, application)
    try {
      await router.handle({
        jsonrpc: '2.0', id: 'causal:submit', method: 'round.submit',
        params: {
          address: ADDRESS, idempotencyKey: 'causal:e2e', principalId: 'principal:player',
          action: { actionType: 'speak', parameters: { text: 'trigger causal chain' } },
          correlationId: 'causal:e2e',
        },
      })
      await new Promise(resolve => setTimeout(resolve, 1000))

      const db = new DatabaseSync(worldPath)
      let reactionPayloads: Array<Record<string, unknown>> = []
      try {
        const rows = db.prepare(`SELECT payload_json FROM outbox ORDER BY delivery_id`).all() as Array<{ payload_json: string }>
        reactionPayloads = rows
          .map(row => JSON.parse(row.payload_json) as Record<string, unknown>)
          .filter(payload => payload.observationType === 'reaction-round')
        expect(reactionPayloads.length).toBeGreaterThanOrEqual(2)

        const waves = reactionPayloads.map(payload => payload.wave as number)
        expect(waves).toContain(1)
        expect(waves).toContain(2)

        const cycleIds = new Set(reactionPayloads.map(payload => payload.cycleId as string))
        expect(cycleIds.size).toBe(1)
        const rootRoundIds = new Set(reactionPayloads.map(payload => payload.rootRoundId as string))
        expect(rootRoundIds.size).toBe(1)
        const roundIds = new Set(reactionPayloads.map(payload => payload.roundId as string))
        expect(roundIds.size).toBeGreaterThanOrEqual(2)

        for (const payload of reactionPayloads) {
          expect(payload).toMatchObject({
            observationType: 'reaction-round',
            observationId: expect.any(String),
            cycleId: expect.any(String),
            wave: expect.any(Number),
            roundId: expect.any(String),
            rootRoundId: expect.any(String),
          })
          expect(typeof payload.value).toBe('object')
          expect(payload.value).not.toBeNull()
        }
      } finally {
        db.close()
      }

      await application.deliver(ADDRESS, 'causal:deliver')
      const sessionDb = new DatabaseSync(sessionPath)
      try {
        const delivered = sessionDb.prepare(`
          SELECT session_event_seq, payload_json
          FROM session_events
          WHERE session_id = 'session:player'
          ORDER BY session_event_seq
        `).all() as Array<{ session_event_seq: number; payload_json: string }>
        const reactionEvents = delivered
          .map(row => ({ ...row, payload: JSON.parse(row.payload_json) as Record<string, unknown> }))
          .filter(row => row.payload.observationType === 'reaction-round')
        expect(reactionEvents.length).toBe(reactionPayloads.length)
        const renderedOrigins: Array<Record<string, unknown>> = []
        for (const event of reactionEvents) {
          const rendered = await application.renderSession(
            ADDRESS,
            brandId('session:player', 'SessionId'),
            event.session_event_seq,
          ) as { readonly text: string; readonly reactionOrigin: Record<string, unknown> }
          expect(rendered.text).toContain('says:')
          expect(rendered.reactionOrigin).toMatchObject({
            rootRoundId: event.payload.rootRoundId,
            cycleId: event.payload.cycleId,
            wave: event.payload.wave,
            roundId: event.payload.roundId,
          })
          renderedOrigins.push(rendered.reactionOrigin)
        }
        expect(renderedOrigins.map(value => value.wave)).toEqual([1, 2])
      } finally {
        sessionDb.close()
      }
    } finally {
      await router.close()
      await application.close()
    }
  }, 30000)

})
