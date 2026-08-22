import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, createErrorEnvelope, WorldError, type WorldAddress } from '@harness-world/contracts'
import {
  BranchQuarantineService,
  BranchAdministration,
  CharacterRuntimeAvailabilityService,
  RoundInbox,
  SessionOutboxWorker,
  WORLD_APPLICATION_ID,
  WorldOutbox,
  WorldStore,
  WriterLeaseService,
} from '@harness-world/store-sqlite'
import { executeLocalCli, parseLocalCli } from './cli.ts'
import { WorldHealthService } from './health.ts'
import { OperationsMetrics } from './metrics.ts'
import { LocalJsonRpcRouter, type LocalJsonRpcRequest, type LocalJsonRpcResponse } from './rpc.ts'

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
      status: 'ready', schemaVersion: 10, branchCount: 1,
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
    await expect(router.handle(request('world.activate', { spec }))).resolves.toMatchObject({ result: { status: 'activated' } })
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
    await expect(router.handle(request('view.character', { address: parent, characterId: 'character:player' })))
      .resolves.toMatchObject({ result: { characterId: 'character:player', asOfWorldSeq: expect.any(Number) } })
    await expect(router.handle(request('view.character', {
      address: parent, characterId: 'character:player', asOfWorldSeq: (head.result as { headSeq: number }).headSeq,
    }))).resolves.toMatchObject({ result: { characterId: 'character:player' } })
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

    const backupPath = join(directory, 'world.backup.sqlite')
    const backup = await router.handle(request('backup.create', { targetPath: backupPath, correlationId: 'rpc:backup' }))
    expect(backup).toMatchObject({ result: { format: 'world-sqlite-backup/v1', fileHash: expect.any(String) } })
    await expect(router.handle(request('backup.restore', {
      backupPath,
      targetPath: join(directory, 'restored.sqlite'),
      expectedHash: (backup.result as { fileHash: string }).fileHash,
      correlationId: 'rpc:restore',
    }))).resolves.toMatchObject({ result: { format: 'world-sqlite-backup/v1' } })

    const portablePath = join(directory, 'world.portable.json')
    await expect(router.handle(request('transfer.export-portable', { exportPath: portablePath, correlationId: 'rpc:portable-export' })))
      .resolves.toMatchObject({ result: { format: 'world-sqlite-backup/v1' } })
    await expect(router.handle(request('transfer.import-portable', {
      exportPath: portablePath, targetPath: join(directory, 'portable-import.sqlite'), correlationId: 'rpc:portable-import',
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
      error: { message: expect.stringContaining('disabled when WorldApplication is configured') },
    })
    await expect(router.handle(request('branch.fork', { parent, child, forkSeq: 0 }))).resolves.toMatchObject({
      error: { message: expect.stringContaining('disabled when WorldApplication is configured') },
    })
    await expect(router.handle(request('branch.archive', {
      address: parent, reason: 'unsafe legacy route', correlationId: 'rpc:unsafe-archive',
    }))).resolves.toMatchObject({ error: { errorCode: 'INVALID_REQUEST' } })
    await expect(router.handle(request('branch.fork-at-head', {
      parent, child, reason: 'checkpoint', correlationId: 'rpc:fork-at-head',
    }))).resolves.toMatchObject({ result: { parentState: { admissionState: 'open' } } })
    await expect(router.handle(request('branch.archive-coordinated', {
      address: parent, reason: 'complete', correlationId: 'rpc:archive-coordinated',
    }))).resolves.toMatchObject({ result: { state: { lifecycleState: 'archived' } } })

    for (const [method, params] of [
      ['round.submit', { ...roundParams, principalId: 'principal:other', idempotencyKey: 'unauthorized' }],
      ['round.submit', { ...roundParams, action: null }],
      ['round.submit', { ...roundParams, action: [] }],
      ['round.submit', { ...roundParams, action: { actionType: 'speak', parameters: {}, extra: true } }],
      ['round.submit', { ...roundParams, correlationId: 1 }],
      ['round.get', { address: child, idempotencyKey: 1 }],
      ['view.character', { address: child, characterId: 'character:player', asOfWorldSeq: -1 }],
      ['view.character', { address: child, characterId: 'character:player', asOfWorldSeq: 'latest' }],
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
    expect(parseLocalCli(['view', 'character', 'tenant', 'world', 'branch', 'character:1']).method).toBe('view.character')
    expect(parseLocalCli(['view', 'character', 'tenant', 'world', 'branch', 'character:1', '2']).params).toMatchObject({ asOfWorldSeq: 2 })
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
    expect(() => parseLocalCli(['view', 'character', 'tenant', 'world', 'branch'])).toThrow('characterId')
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
})
