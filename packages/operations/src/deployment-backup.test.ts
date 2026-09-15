import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  canonicalizeWorldJson,
  hashWorldJson,
  type FaultInjector,
  type FaultPoint,
  type WorldAddress,
} from '@harness-world/contracts'
import { createContextReceipt, openContextDatabase } from '@harness-world/agents'
import { WorldApplication } from '@harness-world/application'
import { LocalMemoryStore } from '@harness-world/memory'
import {
  OperationalAuditLog,
  PlayerInputJobs,
  readPragmaInteger,
  SessionDeliveryAdapter,
  SessionOutboxWorker,
  WORLD_SCHEMA_VERSION,
  WorldOutbox,
  WorldStore,
} from '@harness-world/store-sqlite'
import { DeploymentBackupService, type DeploymentDatabasePaths } from './deployment-backup.ts'
import { intentWorld } from '../../../tests/fixtures/player-intent-world.ts'

const roots: string[] = []

function address(): WorldAddress {
  return {
    tenantId: brandId('tenant:backup', 'TenantId'),
    worldId: brandId('world:backup', 'WorldId'),
    branchId: brandId('branch:main', 'BranchId'),
  }
}

function fixture(withBranch = true): { readonly root: string; readonly paths: DeploymentDatabasePaths } {
  const root = join(tmpdir(), `hcw-deployment-${process.pid}-${roots.length}-${Date.now()}`)
  roots.push(root)
  mkdirSync(root, { recursive: true })
  const paths = {
    worldPath: join(root, 'source', 'world.sqlite'),
    sessionPath: join(root, 'source', 'session.sqlite'),
    memoryPath: join(root, 'source', 'memory.sqlite'),
    contextPath: join(root, 'source', 'context.sqlite'),
    lockPath: join(root, 'source', 'instance.lock'),
    sourceDeployment: 'fixture-deployment',
  }
  const world = new WorldStore(paths.worldPath)
  if (withBranch) world.createBranch(address())
  const session = new SessionDeliveryAdapter(paths.sessionPath)
  session.close()
  const memory = new LocalMemoryStore(paths.memoryPath, world)
  memory.close()
  openContextDatabase(paths.contextPath).close()
  world.close()
  return { root, paths }
}

function rewriteManifest(directory: string, mutate: (manifest: Record<string, unknown>) => void): void {
  const path = join(directory, 'manifest.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  mutate(manifest)
  const { manifestHash: _manifestHash, ...input } = manifest
  manifest.manifestHash = hashWorldJson('world-deployment-backup/v1', input as never)
  writeFileSync(path, canonicalizeWorldJson(manifest as never))
  writeFileSync(join(directory, 'ready'), manifest.manifestHash as string)
}

function throwingFault(point: FaultPoint): FaultInjector {
  return { hit(actual) { if (actual === point) throw new Error(`fault:${point}`) } }
}

async function seedRound(paths: DeploymentDatabasePaths, deliver: boolean, cognitive: boolean): Promise<void> {
  const world = new WorldStore(paths.worldPath)
  await world.commitRound({
    address: address(),
    transactionId: brandId('transaction:backup-round', 'TransactionId'),
    roundId: brandId('round:backup', 'InteractionRoundId'),
    expectedHeadSeq: 0,
    expectedTick: 0,
    nextTick: 1,
    events: [{ eventType: 'observation.upsert', eventVersion: 1, data: { observationId: 'observation:backup' } }],
    outbox: [{
      deliveryId: brandId('delivery:backup', 'DeliveryId'),
      sessionId: brandId('session:player', 'SessionId'),
      payload: { observationId: 'observation:backup' },
      critical: false,
    }],
    ...(cognitive ? { cognitiveJobs: [{ characterId: brandId('character:alice', 'CharacterId') }] } : {}),
    correlationId: 'seed:round',
  })
  world.close()
  const outbox = new WorldOutbox(paths.worldPath, undefined, {
    workerId: 'worker:backup', now: () => 1, createClaimToken: () => 'backup',
  })
  const session = new SessionDeliveryAdapter(paths.sessionPath)
  if (deliver) {
    await new SessionOutboxWorker(outbox, session, address()).runOnce('seed:deliver')
  } else {
    const claimed = outbox.claimNext(address())!
    await outbox.recordDelivered(claimed)
  }
  session.close()
  outbox.close()
  if (cognitive) {
    const worldDb = new DatabaseSync(paths.worldPath)
    worldDb.exec(`UPDATE world_cognitive_jobs SET status = 'completed', attempt_count = 1`)
    worldDb.close()
    const key = `${address().tenantId}\u001f${address().worldId}\u001f${address().branchId}\u001fcharacter:alice`
    const memory = new DatabaseSync(paths.memoryPath)
    memory.prepare(`
      INSERT INTO cognitive_memory_v2_namespaces(
        namespace_key, verified_through_seq, captured_through_seq, memory_epoch, source_map_hash, source_bundle_hash
      ) VALUES (?, 1, 1, 1, 'sha256:map', 'sha256:bundle')
    `).run(key)
    memory.close()
    const receipt = createContextReceipt({
      address: address(), roundId: brandId('round:backup', 'InteractionRoundId'), participantKind: 'character',
      participantId: 'participant:alice', subjectCharacterId: brandId('character:alice', 'CharacterId'),
      controllerId: 'scripted:v2', controllerEpoch: 1, baseHeadSeq: 1, asOfWorldSeq: 1, tick: 1,
      manifestHash: hashWorldJson('manifest:test', {}), contextProfileId: 'compact',
      contextProfileHash: hashWorldJson('context-profile:test', {}),
      versionLocks: {
        contextSchema: 'character-controller/v2', contextReceiptSchema: 'context-receipt/v1',
        sceneDecisionSchema: 'scene-decision/v2', memorySchema: 'cognitive-memory/v2',
        checkpointSchema: 'continuity-checkpoint/v1', rendererSchema: 'structured-prompt-renderer/v1',
      },
      componentHashes: {
        characterViewHash: hashWorldJson('character-view:test', {}),
        sceneDecisionHash: hashWorldJson('scene-decision:test', {}), checkpointHash: null,
        tailHash: hashWorldJson('tail:test', {}), recallHash: hashWorldJson('recall:test', {}),
        affordanceHash: hashWorldJson('affordance:test', {}),
      },
      includedSourceRefs: [], exclusions: [], contextHash: hashWorldJson('context:test', {}),
      providerRequestHash: hashWorldJson('provider-request:test', {}),
    })
    const context = new DatabaseSync(paths.contextPath)
    context.prepare(`
      INSERT INTO continuity_checkpoints(checkpoint_id, namespace_key, as_of_seq, checkpoint_json, checkpoint_hash)
      VALUES ('checkpoint:backup', ?, 1, '{}', 'sha256:checkpoint')
    `).run(key)
    context.prepare(`
      INSERT INTO context_receipts(receipt_id, namespace_key, round_id, participant_id, receipt_json, receipt_hash)
      VALUES (?, ?, 'round:backup', 'participant:alice', ?, ?)
    `).run(receipt.receiptId,
      `${address().tenantId}\u001f${address().worldId}\u001f${address().branchId}`,
      Buffer.from(canonicalizeWorldJson(receipt)).toString('utf8'), receipt.receiptHash)
    context.prepare(`
      INSERT INTO provider_calls(
        model_call_id, namespace_key, round_id, participant_id, receipt_id, receipt_hash,
        controller_epoch, context_hash, provider_request_hash, state
      ) VALUES ('call:terminal', ?, 'round:backup', 'participant:alice', ?, ?,
        1, 'sha256:context', 'sha256:request', 'failed_before_dispatch')
    `).run(`${address().tenantId}\u001f${address().worldId}\u001f${address().branchId}`,
      receipt.receiptId, receipt.receiptHash)
    context.close()
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('DeploymentBackupService', () => {
  it('creates, validates, and restores one ready five-database deployment without rewriting state', async () => {
    const value = fixture()
    const service = new DeploymentBackupService(value.paths, () => 1_000)
    const artifact = join(value.root, 'backup')
    const manifest = await service.backup(artifact, 'deployment:backup')
    expect(manifest).toMatchObject({
      format: 'world-deployment-backup/v1', correlationId: 'deployment:backup', createdAtMs: 1_000,
      sourceDeployment: 'fixture-deployment', files: expect.arrayContaining([
        expect.objectContaining({ role: 'world', path: 'world.sqlite', quickCheck: 'ok' }),
        expect.objectContaining({ role: 'audit', path: 'world.sqlite.audit.sqlite', quickCheck: 'ok' }),
        expect.objectContaining({ role: 'session', path: 'session.sqlite', quickCheck: 'ok' }),
        expect.objectContaining({ role: 'memory', path: 'memory.sqlite', quickCheck: 'ok' }),
        expect.objectContaining({ role: 'context', path: 'context.sqlite', quickCheck: 'ok' }),
      ]),
      watermarks: {
        branches: [expect.objectContaining({ addressKey: expect.stringContaining('branch:main'), headSeq: 0, tick: 0 })],
        outbox: [], sessions: [], memory: [], providerCalls: [], maximumCheckpointAsOfSeq: 0,
        activeReactionCycles: 0, terminalReactionCycles: 0, auditRecords: 1, auditTailHash: expect.stringMatching(/^sha256:/),
      },
      manifestHash: expect.stringMatching(/^sha256:/),
    })
    expect(readFileSync(join(artifact, 'ready'), 'utf8')).toBe(manifest.manifestHash)
    expect(service.validate(artifact, 'deployment:validate')).toEqual(manifest)
    expect(existsSync(value.paths.lockPath)).toBe(false)

    const restored = join(value.root, 'restored')
    const provenance = service.restore(artifact, restored, 'deployment:restore')
    expect(provenance).toMatchObject({
      format: 'world-deployment-restore-provenance/v1', sourceManifestHash: manifest.manifestHash,
      correlationId: 'deployment:restore', restoredAtMs: 1_000,
      checks: expect.arrayContaining(['world-authority', 'cross-store-watermarks']),
      provenanceHash: expect.stringMatching(/^sha256:/),
    })
    expect(readFileSync(join(restored, 'restore-provenance.json'), 'utf8')).toContain(provenance.provenanceHash)
    expect(service.validate(restored, 'deployment:restored-validate')).toEqual(manifest)
  })

  it('rejects target collisions, active writers, incomplete artifacts, and existing restore targets', async () => {
    const value = fixture()
    const { sourceDeployment: _sourceDeployment, ...defaultNamedPaths } = value.paths
    const service = new DeploymentBackupService(defaultNamedPaths, () => 2_000)
    const existing = join(value.root, 'existing')
    mkdirSync(existing)
    await expect(service.backup(existing, 'backup:exists')).rejects.toThrow('target exists')
    await expect(service.backup(join(value.root, 'source'), 'backup:alias')).rejects.toThrow('target exists')

    const raw = new DatabaseSync(value.paths.worldPath)
    const key = `${address().tenantId}\u001f${address().worldId}\u001f${address().branchId}`
    raw.prepare('INSERT INTO writer_lease_counters(address_key, next_fencing_token) VALUES (?, 2)').run(key)
    raw.prepare('INSERT INTO writer_leases(address_key, owner_id, fencing_token, expires_at_ms) VALUES (?, ?, 1, 3000)')
      .run(key, 'writer:active')
    raw.close()
    const blocked = join(value.root, 'blocked')
    await expect(service.backup(blocked, 'backup:not-quiet')).rejects.toThrow('not quiescent')
    expect(existsSync(blocked)).toBe(false)
    expect(existsSync(value.paths.lockPath)).toBe(false)

    const cleanup = new DatabaseSync(value.paths.worldPath)
    cleanup.exec('DELETE FROM writer_leases')
    cleanup.close()
    const artifact = join(value.root, 'artifact')
    const manifest = await service.backup(artifact, 'backup:ready')
    rmSync(join(artifact, 'ready'))
    expect(() => service.validate(artifact, 'validate:incomplete')).toThrow('artifact validation failed')
    writeFileSync(join(artifact, 'ready'), manifest.manifestHash)
    expect(() => service.restore(artifact, existing, 'restore:exists')).toThrow('target exists')
    expect(() => service.restore(artifact, artifact, 'restore:alias')).toThrow('target exists')
  })

  it('fails closed for file, cross-store, Memory, Context, and manifest divergence', async () => {
    const value = fixture()
    const service = new DeploymentBackupService(value.paths, () => 4_000)

    const malformedMemory = new DatabaseSync(value.paths.memoryPath)
    malformedMemory.prepare(`
      INSERT INTO cognitive_memory_v2_namespaces(
        namespace_key, verified_through_seq, captured_through_seq, memory_epoch, source_map_hash, source_bundle_hash
      ) VALUES ('bad', 0, 0, 1, 'sha256:map', 'sha256:bundle')
    `).run()
    malformedMemory.close()
    await expect(service.backup(join(value.root, 'bad-memory'), 'backup:bad-memory')).rejects.toThrow('namespace is malformed')

    const clearMemory = new DatabaseSync(value.paths.memoryPath)
    clearMemory.exec('DELETE FROM cognitive_memory_v2_namespaces')
    clearMemory.close()
    const unfinishedContext = new DatabaseSync(value.paths.contextPath)
    unfinishedContext.prepare(`
      INSERT INTO provider_calls(
        model_call_id, namespace_key, round_id, participant_id, receipt_id, receipt_hash,
        controller_epoch, context_hash, provider_request_hash, state
      ) VALUES ('call:unfinished', ?, 'round:one', 'participant:one', 'receipt:one', 'sha256:receipt', 1,
        'sha256:context', 'sha256:request', 'prepared')
    `).run(`${address().tenantId}\u001f${address().worldId}\u001f${address().branchId}`)
    unfinishedContext.close()
    await expect(service.backup(join(value.root, 'bad-context'), 'backup:bad-context')).rejects.toThrow('ProviderCall is unfinished')

    const clearContext = new DatabaseSync(value.paths.contextPath)
    clearContext.exec('DELETE FROM provider_calls')
    clearContext.close()
    const artifact = join(value.root, 'artifact')
    const manifest = await service.backup(artifact, 'backup:artifact')
    writeFileSync(join(artifact, 'ready'), 'sha256:wrong')
    expect(() => service.validate(artifact, 'validate:ready')).toThrow('manifest hash is invalid')
    writeFileSync(join(artifact, 'ready'), manifest.manifestHash)

    const manifestPath = join(artifact, 'manifest.json')
    const original = readFileSync(manifestPath, 'utf8')
    writeFileSync(manifestPath, `${original}\n`)
    expect(() => service.validate(artifact, 'validate:canonical')).toThrow('canonical bytes are invalid')
    writeFileSync(manifestPath, original)

    const session = new DatabaseSync(join(artifact, 'session.sqlite'))
    session.prepare(`INSERT INTO session_delivery_cursor(session_id, last_delivery_seq) VALUES ('session:orphan', 1)`).run()
    session.close()
    expect(() => service.validate(artifact, 'validate:session')).toThrow('Session integrity failed')
  })

  it('hashes deterministic provenance independently from the backup manifest identity', async () => {
    const value = fixture()
    let now = 7_000
    const service = new DeploymentBackupService(value.paths, () => now++)
    const artifact = join(value.root, 'artifact')
    const manifest = await service.backup(artifact, 'backup:clock')
    const target = join(value.root, 'target')
    const provenance = service.restore(artifact, target, 'restore:clock')
    const { provenanceHash: _hash, ...input } = provenance
    expect(provenance.provenanceHash).toBe(hashWorldJson('world-deployment-restore-provenance/v1', input))
    expect(manifest.createdAtMs).toBeGreaterThanOrEqual(7_000)
  })

  it('preserves non-empty delivery, Memory, Context, and cognitive watermarks in both directions', async () => {
    const value = fixture()
    await seedRound(value.paths, true, true)
    const service = new DeploymentBackupService(value.paths, () => 7_500)
    const artifact = join(value.root, 'rich-artifact')
    const manifest = await service.backup(artifact, 'backup:rich')
    expect(manifest.watermarks).toMatchObject({
      outbox: [{ status: 'delivered', count: 1, maxSessionDeliverySeq: 1 }],
      sessions: [{ sessionId: 'session:player', lastDeliverySeq: 1 }],
      memory: [{ verifiedThroughSeq: 1, capturedThroughSeq: 1, memoryEpoch: 1 }],
      providerCalls: [{ state: 'failed_before_dispatch', count: 1 }],
      maximumCheckpointAsOfSeq: 1,
    })
    const restored = join(value.root, 'rich-restored')
    service.restore(artifact, restored, 'restore:rich')
    expect(service.validate(restored, 'validate:rich')).toEqual(manifest)
  })

  it('preserves completed Player Input and its validated ProviderCall through backup and restore', async () => {
    const value = fixture(false)
    const compiled = intentWorld()
    const app = new WorldApplication({ ...value.paths, modelBudgetTokens: 20,
      playerIntent: {
        profile: { version: 'player-intent-profile/v1', providerId: 'fixture', modelId: 'fixture', timeoutMs: 1000, maxOutputTokens: 10 },
        dispatch: async () => ({ version: 'player-intent-candidate/v3', decision: 'act', reason: 'none',
          actions: [{ key: 'a', affordanceId: 'speak', quotes: ['你好'] }],
          }),
      },
    })
    app.activate(compiled)
    expect(await app.submitText(compiled.manifest.address, {
      text: '你好', idempotencyKey: 'backup-input', principalId: 'principal:player', correlationId: 'backup-input',
    })).toMatchObject({ status: 'submitted' })
    await app.deliver(compiled.manifest.address, 'backup-input:deliver')
    await app.close()

    const service = new DeploymentBackupService(value.paths, () => Date.now() + 60_000)
    const artifact = join(value.root, 'player-input-artifact')
    const manifest = await service.backup(artifact, 'backup:player-input')
    expect(manifest.watermarks.providerCalls).toContainEqual({ state: 'validated', count: 1 })
    const restored = join(value.root, 'player-input-restored')
    service.restore(artifact, restored, 'restore:player-input')
    expect(service.validate(restored, 'validate:player-input')).toEqual(manifest)
    const restoredJobs = new PlayerInputJobs(join(restored, 'world.sqlite'))
    try {
      expect(restoredJobs.read(compiled.manifest.address, 'backup-input')).toMatchObject({ status: 'completed' })
    } finally { restoredJobs.close() }

    const detached = new DatabaseSync(value.paths.worldPath)
    detached.prepare('DELETE FROM player_input_jobs WHERE idempotency_key = ?').run('backup-input')
    detached.close()
    await expect(service.backup(join(value.root, 'detached-player-call'), 'backup:detached-player-call'))
      .rejects.toThrow('Player Intent ProviderCall has no matching World input authority')
  })

  it('rejects backup while an accepted Player Input still needs work', async () => {
    const value = fixture(false)
    const compiled = intentWorld()
    const app = new WorldApplication(value.paths)
    app.activate(compiled)
    await app.close()
    const jobs = new PlayerInputJobs(value.paths.worldPath)
    jobs.receive(compiled.manifest.address, 'principal:player', 'unfinished-input', { text: '你好' }, 2)
    jobs.close()
    const service = new DeploymentBackupService(value.paths, () => Date.now() + 60_000)
    await expect(service.backup(join(value.root, 'unfinished-player-input'), 'backup:unfinished-player-input'))
      .rejects.toThrow('deployment is not quiescent')
  })

  it('removes normal-failure partial artifacts before either ready marker is published', async () => {
    const value = fixture()
    const backupTarget = join(value.root, 'backup-fault')
    const backupFault = new DeploymentBackupService(value.paths, () => 8_000, throwingFault('deployment-backup.before-ready'))
    await expect(backupFault.backup(backupTarget, 'backup:fault')).rejects.toThrow('fault:deployment-backup.before-ready')
    expect(existsSync(backupTarget)).toBe(false)
    expect(existsSync(value.paths.lockPath)).toBe(false)

    const artifact = join(value.root, 'artifact')
    await new DeploymentBackupService(value.paths, () => 8_001).backup(artifact, 'backup:clean')
    const restoreTarget = join(value.root, 'restore-fault')
    const restoreFault = new DeploymentBackupService(value.paths, () => 8_002, throwingFault('deployment-restore.before-ready'))
    expect(() => restoreFault.restore(artifact, restoreTarget, 'restore:fault')).toThrow('fault:deployment-restore.before-ready')
    expect(existsSync(restoreTarget)).toBe(false)
  })

  it('detects a source deployment change during the fixed-order copy', async () => {
    const value = fixture()
    let changed = false
    const service = new DeploymentBackupService(value.paths, () => 9_000, {
      hit(point) {
        if (point !== 'deployment-backup.after-file-copy' || changed) return
        changed = true
        const audit = new OperationalAuditLog(`${value.paths.worldPath}.audit.sqlite`, () => 9_000)
        audit.record('deployment', 'test.concurrent-change', 'backup:change', {})
        audit.close()
      },
    })
    const target = join(value.root, 'changed')
    await expect(service.backup(target, 'backup:change')).rejects.toThrow('source deployment changed')
    expect(existsSync(target)).toBe(false)
  })

  it.each([
    ['format', (manifest: Record<string, unknown>) => { manifest.format = 'wrong' }],
    ['correlation', (manifest: Record<string, unknown>) => { manifest.correlationId = '' }],
    ['source', (manifest: Record<string, unknown>) => { manifest.sourceDeployment = '' }],
    ['time-type', (manifest: Record<string, unknown>) => { manifest.createdAtMs = 'now' }],
    ['time-range', (manifest: Record<string, unknown>) => { manifest.createdAtMs = -1 }],
    ['files', (manifest: Record<string, unknown>) => { manifest.files = [] }],
  ] as const)('rejects a structurally invalid manifest field: %s', async (_name, mutate) => {
    const value = fixture()
    const artifact = join(value.root, 'artifact')
    const service = new DeploymentBackupService(value.paths, () => 10_000)
    await service.backup(artifact, 'backup:shape')
    rewriteManifest(artifact, mutate)
    expect(() => service.validate(artifact, 'validate:shape')).toThrow('manifest shape')
  })

  it('rejects invalid operation clocks and copied-file or watermark divergence', async () => {
    const value = fixture()
    await expect(new DeploymentBackupService(value.paths, () => -1)
      .backup(join(value.root, 'bad-clock'), 'backup:clock')).rejects.toThrow(RangeError)
    const artifact = join(value.root, 'artifact')
    const service = new DeploymentBackupService(value.paths, () => 11_000)
    await service.backup(artifact, 'backup:artifact')
    expect(() => new DeploymentBackupService(value.paths).validate(artifact, 'validate:default-clock')).not.toThrow()

    rewriteManifest(artifact, manifest => {
      const watermarks = manifest.watermarks as Record<string, unknown>
      watermarks.auditRecords = 999
    })
    expect(() => service.validate(artifact, 'validate:watermark')).toThrow('watermarks diverged')
  })

  it('supports an empty deployment with a genesis audit watermark', async () => {
    const value = fixture(false)
    const manifest = await new DeploymentBackupService(value.paths, () => 12_000)
      .backup(join(value.root, 'empty'), 'backup:empty')
    expect(manifest.watermarks).toMatchObject({ branches: [], auditRecords: 0, auditTailHash: 'genesis' })
  })

  it('migrates an equivalent populated v15 deployment without rewriting its authority before backup and restore', async () => {
    const value = fixture()
    await seedRound(value.paths, true, false)
    const legacy = new DatabaseSync(value.paths.worldPath)
    legacy.exec(`
      DROP TABLE world_reaction_job_stimuli;
      DROP TABLE player_input_jobs;
      DROP TABLE world_reaction_jobs;
      DROP TABLE world_reaction_waves;
      DROP TABLE world_reaction_cycles;
      DROP INDEX events_type_range;
      PRAGMA user_version = 15;
    `)
    const before = {
      branches: legacy.prepare('SELECT * FROM branches ORDER BY address_key').all(),
      heads: legacy.prepare('SELECT * FROM heads ORDER BY address_key').all(),
      rounds: legacy.prepare('SELECT * FROM round_commits ORDER BY transaction_id').all(),
      events: legacy.prepare('SELECT * FROM events ORDER BY address_key, seq').all(),
      outbox: legacy.prepare('SELECT * FROM outbox ORDER BY delivery_id').all(),
    }
    legacy.close()

    const migrated = new WorldStore(value.paths.worldPath)
    expect(migrated.verifyBranchIntegrity(address()).headSeq).toBe(1)
    expect(migrated.listReactionCycles(address())).toEqual([])
    migrated.close()
    const check = new DatabaseSync(value.paths.worldPath, { readOnly: true })
    expect(readPragmaInteger(check, 'user_version')).toBe(WORLD_SCHEMA_VERSION)
    expect({
      branches: check.prepare('SELECT * FROM branches ORDER BY address_key').all(),
      heads: check.prepare('SELECT * FROM heads ORDER BY address_key').all(),
      rounds: check.prepare('SELECT * FROM round_commits ORDER BY transaction_id').all(),
      events: check.prepare('SELECT * FROM events ORDER BY address_key, seq').all(),
      outbox: check.prepare('SELECT * FROM outbox ORDER BY delivery_id').all(),
    }).toEqual(before)
    check.close()

    const service = new DeploymentBackupService(value.paths, () => 12_500)
    const artifact = join(value.root, 'migrated-backup')
    await service.backup(artifact, 'backup:v15-migrated')
    const restored = join(value.root, 'migrated-restored')
    service.restore(artifact, restored, 'restore:v15-migrated')
    expect(service.validate(restored, 'validate:v15-migrated').watermarks.branches)
      .toEqual(service.validate(artifact, 'validate:v15-source').watermarks.branches)
  })

  it('fails closed across every populated cross-store boundary', async () => {
    const reject = async (
      name: string,
      mutate: (paths: DeploymentDatabasePaths) => void | Promise<void>,
      message: string,
    ) => {
      const value = fixture()
      await mutate(value.paths)
      await expect(new DeploymentBackupService(value.paths, () => 13_000)
        .backup(join(value.root, `rejected-${name}`), `backup:${name}`)).rejects.toThrow(message)
    }
    const key = `${address().tenantId}\u001f${address().worldId}\u001f${address().branchId}`
    const insertMemory = (paths: DeploymentDatabasePaths, namespace: string, verified: number, captured: number) => {
      const db = new DatabaseSync(paths.memoryPath)
      db.prepare(`
        INSERT INTO cognitive_memory_v2_namespaces(
          namespace_key, verified_through_seq, captured_through_seq, memory_epoch, source_map_hash, source_bundle_hash
        ) VALUES (?, ?, ?, 1, 'sha256:map', 'sha256:bundle')
      `).run(namespace, verified, captured)
      db.close()
    }
    const insertReceipt = (paths: DeploymentDatabasePaths, value: unknown) => {
      const db = new DatabaseSync(paths.contextPath)
      db.prepare(`
        INSERT INTO context_receipts(receipt_id, namespace_key, round_id, participant_id, receipt_json, receipt_hash)
        VALUES ('receipt:bad', ?, 'round:bad', 'participant:bad', ?, 'sha256:bad')
      `).run(key, JSON.stringify(value))
      db.close()
    }

    await reject('identity', paths => {
      const db = new DatabaseSync(paths.memoryPath); db.exec('PRAGMA application_id = 1'); db.close()
    }, 'application identity')
    await reject('world', paths => {
      const db = new DatabaseSync(paths.worldPath); db.exec(`UPDATE heads SET event_hash = 'sha256:wrong'`); db.close()
    }, 'World authority')
    await reject('audit', paths => {
      const db = new DatabaseSync(`${paths.worldPath}.audit.sqlite`)
      db.exec(`UPDATE operational_audit_events SET details_json = '{"tampered":true}'`)
      db.close()
    }, 'audit hash chain')
    await reject('provider-hash', paths => {
      const db = new DatabaseSync(paths.contextPath)
      db.prepare(`
        INSERT INTO provider_calls(
          model_call_id, namespace_key, round_id, participant_id, receipt_id, receipt_hash, controller_epoch,
          context_hash, provider_request_hash, state, response_json, response_hash
        ) VALUES ('call:bad', ?, 'round:bad', 'participant:bad', 'receipt:bad', 'sha256:receipt', 1,
          'sha256:context', 'sha256:request', 'failed_before_dispatch', '{}', 'sha256:wrong')
      `).run(key)
      db.close()
    }, 'ProviderCall integrity')
    await reject('memory-empty-segment', paths => insertMemory(paths, `a\u001fb\u001fc\u001f`, 0, 0), 'namespace is malformed')
    await reject('memory-branch', paths => insertMemory(paths, `tenant:x\u001fworld:x\u001fbranch:x\u001fcharacter:x`, 0, 0), 'Memory Branch is missing')
    await reject('memory-order', paths => insertMemory(paths, `${key}\u001fcharacter:x`, 0, 1), 'captured watermark exceeds')
    await reject('memory-future', paths => insertMemory(paths, `${key}\u001fcharacter:x`, 1, 1), 'exceeds World Head')
    await reject('memory-required', async paths => {
      await seedRound(paths, true, true)
      const db = new DatabaseSync(paths.memoryPath); db.exec('DELETE FROM cognitive_memory_v2_namespaces'); db.close()
    }, 'Memory is absent')
    await reject('memory-behind', async paths => {
      await seedRound(paths, true, true)
      const db = new DatabaseSync(paths.memoryPath)
      db.exec('UPDATE cognitive_memory_v2_namespaces SET captured_through_seq = 0')
      db.close()
    }, 'Memory capture is behind')
    await reject('session-world', paths => seedRound(paths, false, false), 'delivery bindings diverged')
    await reject('provider-world', paths => {
      const db = new DatabaseSync(paths.contextPath)
      db.prepare(`
        INSERT INTO provider_calls(
          model_call_id, namespace_key, round_id, participant_id, receipt_id, receipt_hash, controller_epoch,
          context_hash, provider_request_hash, state, transaction_id, authority_hash
        ) VALUES ('call:committed', ?, 'round:bad', 'participant:bad', 'receipt:bad', 'sha256:receipt', 1,
          'sha256:context', 'sha256:request', 'committed', 'transaction:missing', 'sha256:authority')
      `).run(key)
      db.close()
    }, 'matching World authority')
    await reject('checkpoint-branch', paths => {
      const db = new DatabaseSync(paths.contextPath)
      db.prepare(`INSERT INTO continuity_checkpoints VALUES ('checkpoint:bad', ?, 0, '{}', 'sha256:bad')`)
        .run(`tenant:x\u001fworld:x\u001fbranch:x\u001fcharacter:x`)
      db.close()
    }, 'checkpoint Branch is missing')
    await reject('checkpoint-future', paths => {
      const db = new DatabaseSync(paths.contextPath)
      db.prepare(`INSERT INTO continuity_checkpoints VALUES ('checkpoint:bad', ?, 1, '{}', 'sha256:bad')`)
        .run(`${key}\u001fcharacter:x`)
      db.close()
    }, 'checkpoint exceeds')
    await reject('receipt-address', paths => insertReceipt(paths, { asOfWorldSeq: 0 }), 'no World address')
    await reject('receipt-seq', paths => insertReceipt(paths, { address: address() }), 'no as-of sequence')
    await reject('receipt-branch', paths => insertReceipt(paths, {
      address: { tenantId: 'tenant:x', worldId: 'world:x', branchId: 'branch:x' }, asOfWorldSeq: 0,
    }), 'receipt Branch is missing')
    await reject('receipt-future', paths => insertReceipt(paths, { address: address(), asOfWorldSeq: 1 }), 'receipt exceeds')
  })

  it('detects changed file bytes and cleans a restore changed during copying', async () => {
    const value = fixture()
    const artifact = join(value.root, 'artifact')
    const service = new DeploymentBackupService(value.paths, () => 14_000)
    await service.backup(artifact, 'backup:file-change')
    const memory = new DatabaseSync(join(artifact, 'memory.sqlite'))
    memory.exec('CREATE TABLE unexpected(value TEXT) STRICT')
    memory.close()
    expect(() => service.validate(artifact, 'validate:file-change')).toThrow('files diverged')

    const clean = join(value.root, 'clean')
    await service.backup(clean, 'backup:clean-again')
    const target = join(value.root, 'restore-changing')
    let copies = 0
    const changingRestore = new DeploymentBackupService(value.paths, () => 14_001, {
      hit(point) {
        if (point !== 'deployment-restore.after-file-copy' || ++copies !== 5) return
        const db = new DatabaseSync(join(target, 'memory.sqlite'))
        db.exec('CREATE TABLE changed_during_restore(value TEXT) STRICT')
        db.close()
      },
    })
    expect(() => changingRestore.restore(clean, target, 'restore:changing')).toThrow('restored deployment does not match')
    expect(existsSync(target)).toBe(false)
  })
})
