import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
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
    expect(await reopened.read.eventHistory(f.world.manifest.address)).not.toHaveLength(0)
    expect(existsSync(f.paths.contextPath)).toBe(false)
  } finally { await reopened.close() }
})

it('drains admitted player work and delivery before maintenance without an NPC worker', async () => {
  const f = fixture({}, true)
  await f.app.acceptRound(f.world.manifest.address, { idempotencyKey: 'before-maintenance',
    principalId: 'principal:player', correlationId: 'before-maintenance',
    action: { actionType: 'speak', parameters: { text: '先提交这句话。' } } })
  expect(await f.app.admin.enterMaintenance(f.world.manifest.address, 'maintenance check', 'maintenance'))
    .toMatchObject({ drainedRounds: 1, state: { runtimePhase: 'maintenance' } })
  expect(await f.app.roundResult(f.world.manifest.address, 'before-maintenance')).toMatchObject({ status: 'accepted' })
  await f.app.admin.exitMaintenance(f.world.manifest.address, 'continue', 'maintenance-exit')
  expect(await f.submit()).toMatchObject({ status: 'accepted' })
})
