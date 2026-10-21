import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId } from '@harness-world/contracts'
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
  expect(await f.app.listReactionCycles(f.world.manifest.address)).toEqual([])
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

it('reads legacy cycle history but refuses to resume its unfinished NPC work', async () => {
  const f = fixture({}, true)
  const store = new WorldStore(f.paths.worldPath)
  try {
    const head = store.head(f.world.manifest.address)
    await store.commitRound({ address: f.world.manifest.address,
      transactionId: brandId('transaction:legacy-cycle', 'TransactionId'), roundId: brandId('round:legacy-cycle', 'InteractionRoundId'),
      expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
      events: [{ eventType: 'observation.upsert', eventVersion: 1,
        data: { id: 'observation:legacy', value: { observerId: 'character:npc', content: '旧刺激' } } }],
      outbox: [], correlationId: 'legacy-fixture', reactionCycle: {
        policyVersion: 'reaction-policy/v1', profileId: 'responsive/v1', maxWaves: 3, maxNpcCalls: 1,
        maxCallsPerCharacter: 2, maxActionsPerCall: 2, allowedActionTypes: ['speak@1', 'move@1', 'interact@2'], initialTokenBudget: 4,
        deadlineAtMs: Date.now() + 30_000, candidates: [{ characterId: brandId('character:npc', 'CharacterId'),
          estimatedTokens: 1, stimuli: [{ sourceEventOrdinal: 0, observationOrdinal: 0,
            observationId: 'observation:legacy', observerCharacterId: brandId('character:npc', 'CharacterId') }] }],
      } })
    const events = store.readEvents(f.world.manifest.address)
    expect(await f.app.listReactionCycles(f.world.manifest.address)).toHaveLength(1)
    expect(await f.app.eventHistory(f.world.manifest.address)).toEqual(events)
    await expect(f.app.enterMaintenance(f.world.manifest.address, 'legacy check', 'legacy-maintenance'))
      .rejects.toThrow('unfinished legacy NPC Reaction Cycles')
    await expect(f.submit()).rejects.toThrow('unfinished legacy NPC Reaction Cycles')
    expect(store.readEvents(f.world.manifest.address)).toEqual(events)
  } finally { store.close() }
})
