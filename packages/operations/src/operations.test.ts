import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, type WorldAddress } from '@harness-world/contracts'
import { WORLD_APPLICATION_ID, WorldStore } from '@harness-world/store-sqlite'
import { executeLocalCli, parseLocalCli } from './cli.ts'
import { WorldHealthService } from './health.ts'
import { OperationsMetrics } from './metrics.ts'
import { LocalJsonRpcRouter, type LocalJsonRpcRequest } from './rpc.ts'

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
  it('keeps fixed-cardinality counters and reports ready, missing, mismatched, and corrupt stores', () => {
    const metrics = new OperationsMetrics()
    metrics.increment('rpc_requests', 2)
    expect(metrics.snapshot()).toMatchObject({ rpc_requests: 2, rpc_errors: 0 })
    expect(() => metrics.increment('rpc_errors', 0)).toThrow(RangeError)

    const { directory, path, parent } = fixture()
    expect(new WorldHealthService(path).check()).toMatchObject({ status: 'degraded', detail: 'world database is missing' })
    const store = new WorldStore(path)
    store.createBranch(parent)
    store.close()
    expect(new WorldHealthService(path).check()).toMatchObject({ status: 'ready', schemaVersion: 8, branchCount: 1 })

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
})

describe('worldctl grammar', () => {
  it('maps local commands to RPC and emits canonical one-line output', async () => {
    expect(parseLocalCli(['health']).method).toBe('health.get')
    expect(parseLocalCli(['metrics']).method).toBe('metrics.get')
    expect(parseLocalCli(['branch', 'status', 'tenant', 'world', 'branch']).method).toBe('branch.status')
    expect(parseLocalCli(['branch', 'audit', 'tenant', 'world', 'branch']).method).toBe('audit.list')
    expect(parseLocalCli(['branch', 'drain', 'tenant', 'world', 'branch', 'planned', 'work']).params).toMatchObject({ reason: 'planned work' })
    expect(parseLocalCli(['branch', 'open', 'tenant', 'world', 'branch', 'done']).method).toBe('branch.open')
    expect(parseLocalCli(['branch', 'archive', 'tenant', 'world', 'branch', 'complete']).method).toBe('branch.archive')
    expect(() => parseLocalCli(['unknown'])).toThrow('unknown worldctl')
    expect(() => parseLocalCli(['branch'])).toThrow('unknown worldctl')
    expect(() => parseLocalCli(['branch', 'status'])).toThrow('requires tenantId')
    expect(() => parseLocalCli(['branch', 'drain', 'tenant', 'world', 'branch'])).toThrow('requires a reason')
    expect(() => parseLocalCli(['branch', 'unknown', 'tenant', 'world', 'branch'])).toThrow('unknown branch')

    const { path, parent } = fixture()
    const store = new WorldStore(path)
    store.createBranch(parent)
    store.close()
    const router = new LocalJsonRpcRouter(path)
    const line = await executeLocalCli(['health'], router)
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0', result: { status: 'ready' } })
    router.close()
  })
})
