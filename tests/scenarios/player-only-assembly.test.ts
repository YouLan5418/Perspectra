import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { WorldStore } from '@harness-world/store-sqlite'
import { basicInteractionPackage, frozenInteractionWorld } from '../fixtures/frozen-interaction-world.ts'

const fixtures: { app: WorldApplication; directory: string }[] = []
afterEach(async () => {
  for (const { app, directory } of fixtures.splice(0)) {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(options: Partial<ConstructorParameters<typeof WorldApplication>[0]>, responsive = false) {
  const directory = mkdtempSync(join(tmpdir(), 'perspectra-player-assembly-'))
  const paths = { worldPath: join(directory, 'world.sqlite'), sessionPath: join(directory, 'session.sqlite'),
    memoryPath: join(directory, 'memory.sqlite'), contextPath: join(directory, 'context.sqlite') }
  const world = frozenInteractionWorld(responsive ? 'responsive/v1' : undefined)
  const app = new WorldApplication({ ...paths, interactionPackages: [basicInteractionPackage], ...options })
  fixtures.push({ app, directory })
  app.activate(world)
  const submit = () => app.submit(world.manifest.address, { idempotencyKey: 'assembly:speech',
    principalId: 'principal:player', correlationId: 'assembly:speech',
    action: { actionType: 'speak', parameters: { text: '装配检查：我在这里。' } } })
  return { app, world, paths, submit }
}

it('submits players and captures authorized sources without opening unused NPC context storage', async () => {
  const f = fixture({}, true)
  const before = await f.app.head(f.world.manifest.address)
  expect(existsSync(f.paths.contextPath)).toBe(false)
  const result = await f.submit()
  expect(result.status).toBe('accepted')
  expect(await f.submit()).toEqual(result)
  expect(existsSync(f.paths.contextPath)).toBe(false)
  const memory = new DatabaseSync(f.paths.memoryPath, { readOnly: true })
  try {
    expect(memory.prepare(`SELECT count(*) AS n FROM cognitive_memory_v2_sources
      WHERE source_seq > ? AND text_value LIKE ?`).get(before.headSeq, '%装配检查%')?.n).toBeGreaterThan(0)
  } finally { memory.close() }
})

it('reopens a committed player Round without loading the retired NPC runtime', async () => {
  const f = fixture({}, true)
  const result = await f.submit()
  await f.app.close()
  const reopened = new WorldApplication({ ...f.paths, interactionPackages: [basicInteractionPackage] })
  try {
    expect(await reopened.roundResult(f.world.manifest.address, 'assembly:speech')).toEqual(result)
    expect(await reopened.eventHistory(f.world.manifest.address)).not.toHaveLength(0)
    expect(existsSync(f.paths.contextPath)).toBe(false)
  } finally { await reopened.close() }
})

it('drains admitted player work and delivery before maintenance without an NPC worker', async () => {
  const f = fixture({}, true)
  await f.app.acceptRound(f.world.manifest.address, { idempotencyKey: 'before-maintenance',
    principalId: 'principal:player', correlationId: 'before-maintenance',
    action: { actionType: 'speak', parameters: { text: '先提交这句话。' } } })
  expect(await f.app.enterMaintenance(f.world.manifest.address, 'maintenance check', 'maintenance'))
    .toMatchObject({ drainedRounds: 1, state: { runtimePhase: 'maintenance' } })
  expect(await f.app.roundResult(f.world.manifest.address, 'before-maintenance')).toMatchObject({ status: 'accepted' })
  await f.app.exitMaintenance(f.world.manifest.address, 'continue', 'maintenance-exit')
  expect(await f.submit()).toMatchObject({ status: 'accepted' })
})

it('drops retired Reaction Cycle tables and keeps a legacy-linked Round verifiable', async () => {
  const f = fixture({}, true)
  const address = f.world.manifest.address
  expect(await f.submit()).toMatchObject({ status: 'accepted' })
  await f.app.close()
  // Rebuild what a schema-19 world that once ran an NPC Reaction Cycle looks like to the migration: the
  // Cycle tables exist and the player Round that opened the Cycle stored a bundle hash covering it.
  const raw = new DatabaseSync(f.paths.worldPath)
  const { transaction_id: transactionId } = raw.prepare(
    'SELECT transaction_id FROM round_commits ORDER BY head_seq DESC LIMIT 1').get() as { transaction_id: string }
  raw.exec(`
    ALTER TABLE round_commits DROP COLUMN legacy_reaction_link;
    CREATE TABLE world_reaction_cycles(cycle_id TEXT PRIMARY KEY, root_transaction_id TEXT NOT NULL);
    CREATE TABLE world_reaction_waves(cycle_id TEXT NOT NULL, result_transaction_id TEXT);
    CREATE TABLE world_reaction_jobs(job_id TEXT PRIMARY KEY);
    CREATE TABLE world_reaction_job_stimuli(job_id TEXT NOT NULL);
    PRAGMA user_version = 19;
  `)
  raw.prepare(`INSERT INTO world_reaction_cycles VALUES ('cycle:legacy', ?)`).run(transactionId)
  raw.prepare(`UPDATE round_commits SET bundle_hash = ? WHERE transaction_id = ?`).run(`sha256:${'f'.repeat(64)}`, transactionId)
  raw.close()

  const store = new WorldStore(f.paths.worldPath)
  try {
    const db = new DatabaseSync(f.paths.worldPath, { readOnly: true })
    try {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'world_reaction_%'`).all()).toEqual([])
      expect(db.prepare('SELECT legacy_reaction_link AS flag FROM round_commits WHERE transaction_id = ?')
        .get(transactionId)).toEqual({ flag: 1 })
    } finally { db.close() }
    expect(() => store.verifyBranchIntegrity(address)).not.toThrow()
  } finally { store.close() }

  const reopened = new WorldApplication({ ...f.paths, interactionPackages: [basicInteractionPackage] })
  try {
    await expect(reopened.submit(address, { idempotencyKey: 'after-retirement', principalId: 'principal:player',
      correlationId: 'after-retirement', action: { actionType: 'speak', parameters: { text: '旧存档继续。' } } }))
      .resolves.toMatchObject({ status: 'accepted' })
  } finally { await reopened.close() }
})
