import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, createErrorEnvelope, type WorldAddress } from '@harness-world/contracts'
import {
  BranchQuarantineService,
  SessionOutboxWorker,
  WORLD_APPLICATION_ID,
  WorldOutbox,
  WorldStore,
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
      status: 'ready', schemaVersion: 9, branchCount: 1,
      readyForRead: true, readyForWrite: true, readyForAgentCalls: true,
      branches: [{ status: 'healthy', readyForRead: true, readyForWrite: true, readyForAgentCalls: true }],
    })
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
    router.close()
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
    expect(submitted).toMatchObject({ result: { status: 'accepted', tick: 1 } })
    await expect(router.handle(request('round.get', { address: parent, idempotencyKey: 'rpc-round' })))
      .resolves.toMatchObject({ result: submitted.result })
    const head = await router.handle(request('world.head', { address: parent }))
    expect(head).toMatchObject({ result: { tick: 1 } })
    await expect(router.handle(request('view.character', { address: parent, characterId: 'character:player' })))
      .resolves.toMatchObject({ result: { characterId: 'character:player', asOfWorldSeq: expect.any(Number) } })
    await expect(router.handle(request('view.character', {
      address: parent, characterId: 'character:player', asOfWorldSeq: (head.result as { headSeq: number }).headSeq,
    }))).resolves.toMatchObject({ result: { characterId: 'character:player' } })
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
      .resolves.toMatchObject({ result: { delivered: 1 } })
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
      ['round.get', { address: child, idempotencyKey: 1 }],
      ['view.character', { address: child, characterId: 'character:player', asOfWorldSeq: -1 }],
      ['view.character', { address: child, characterId: 'character:player', asOfWorldSeq: 'latest' }],
      ['session.render', { address: child, sessionId: 'session:player', sessionEventSeq: 1, locale: 'fr' }],
    ] as const) {
      await expect(router.handle(request(method, params as never))).resolves.toMatchObject({ error: { errorCode: expect.any(String) } })
    }
    router.close()
    await application.close()

    const legacy = new LocalJsonRpcRouter(path)
    await expect(legacy.handle(request('world.head', { address: child })))
      .resolves.toMatchObject({ error: { message: expect.stringContaining('not configured') } })
    legacy.close()
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
    await expect(executeLocalCli(['health'], router, { busyRetryTimeoutMs: -1 })).rejects.toThrow('busyRetryTimeoutMs')
    await expect(executeLocalCli(['health'], router, { busyRetryDelayMs: 0 })).rejects.toThrow('busyRetryDelayMs')
    expect(router.metrics.snapshot()).toMatchObject({ rpc_requests: 2, rpc_errors: 1 })
    router.close()
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
