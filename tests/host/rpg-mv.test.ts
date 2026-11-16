import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import scenarioJson from '../../examples/rpg-mv/scenario.json' with { type: 'json' }
import { addRpgMvExample } from '../support/rpg-mv-fixture.ts'
import { copyRpgFixture, openRpgFixture, type RpgFixture } from '../support/rpg-fixture.ts'
import { LensSimulation } from '../../apps/host/src/lens/simulation.ts'
import { applyScenario, parseScenario } from '../../apps/host/src/lens/scenario.ts'
import { FrontendActions, projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'

type Json = Record<string, any>
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const game = (f: Pick<RpgFixture, 'events'>) =>
  (f.events().findLast(e => e.eventType === 'activity.updated')!.data as Json).state.game
async function act(f: RpgFixture, skill: string, target = '遗迹守卫') {
  const current = projectPlayerView(await f.runtime.state()),
    offered = current.actions.find(row => row.label === '使用技能')!
  return new FrontendActions(f.runtime).perform({
    requestId: randomUUID(),
    actionId: randomUUID(),
    operation: 'perform',
    payload: { optionId: offered.id, arguments: { skill, target } },
  })
}
it('runs and deterministically replays the complete Lens scenario against real official commits', async () => {
  const fixture = copyRpgFixture({ config: addRpgMvExample })
  cleanup.push(() => rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const snapshots: unknown[] = []
  for (let run = 0; run < 2; run++) {
    const lens = await LensSimulation.open(fixture.pack)
    try {
      const result = await applyScenario(lens, parseScenario(scenarioJson))
      expect(
        result.passed,
        JSON.stringify(result.steps.map(step => ({ error: step.error, expectations: step.expectations }))),
      ).toBe(true)
      const committed = lens.events().filter(e => e.eventType === 'activity.updated')
      expect(committed.length).toBeGreaterThan(7)
      expect((committed.at(-1)!.data as Json).state.game.public.cleared).toBe(true)
      snapshots.push(committed.map(e => (e.data as Json).state.game))
    } finally {
      await lens.close()
    }
  }
  expect(snapshots[1]).toEqual(snapshots[0])
}, 60_000)

it('charges a multi-effect cast once, rejects stale/unauthorized targets, and cleanses only negatives before ticking', async () => {
  const f = await openRpgFixture({
    config: addRpgMvExample,
    places: { 'character:player': 'location:ruin-1', 'character:cheng': 'location:living-room' },
  })
  cleanup.push(() => f.close())
  await f.runtime.submit('开始。')
  const initial = projectPlayerView(await f.runtime.state()),
    old = initial.actions.find(row => row.label === '使用技能')!
  await act(f, '破甲击')
  expect(game(f).public.units.find((u: Json) => u.id === 'golem').hp).toBe(46)
  expect(game(f).public.units[0].stats.mp).toBe(7)
  const before = structuredClone(game(f))
  await expect(act(f, '炽热护盾', '遗迹守卫')).rejects.toThrow()
  expect(game(f)).toEqual(before)
  await expect(
    new FrontendActions(f.runtime).perform({
      requestId: randomUUID(),
      actionId: randomUUID(),
      operation: 'perform',
      payload: { optionId: old.id, arguments: { skill: '破甲击', target: '遗迹守卫' } },
    }),
  ).rejects.toThrow()
  expect(game(f)).toEqual(before)
  await act(f, '燃烧火球')
  await act(f, '炽热护盾', '玩家')
  expect(game(f).internal.conditions.some((c: Json) => c.unitId === 'character:player' && c.statusId === 'burn')).toBe(
    true,
  )
  const view = await act(f, '净化振奋', '玩家')
  expect(game(f).internal.conditions.filter((c: Json) => c.unitId === 'character:player')).toEqual([
    { unitId: 'character:player', statusId: 'focus', remaining: 1 },
  ])
  expect(view.battle!.units[0]!.statuses).toEqual([
    { name: '振奋', remaining: 1, timing: 'round-end', polarity: 'positive' },
  ])
  expect(game(f).public.units[0].stats.mp).toBe(3)
})

it('shares the action interpreter with NPCs/enemies and reuses host-recorded randomness on regeneration', async () => {
  const f = await openRpgFixture({
    config: c => {
      const companion = structuredClone(c.characters['character:cheng'])
      addRpgMvExample(c)
      c.characters['character:cheng'] = companion
      companion.skills.push('flame')
      c.enemies.golem.hp = 100
      c.enemies.golem.strategy = 'random'
    },
    places: { 'character:player': 'location:ruin-1', 'character:cheng': 'location:ruin-1' },
    decide: input => {
      const context = input.context as Json,
        activity = context.activity
      return activity?.game.turn === 'character:cheng' && !input.continuation
        ? {
            decision: 'perform',
            actionType: 'interact',
            parameters: {
              targetRef: { kind: 'character', id: 'character:cheng' },
              bindingId: activity.id,
              definitionRef: { id: 'activity:skill', version: 1 },
              arguments: {
                activityId: activity.id,
                revision: activity.revision,
                skill: '燃烧火球',
                target: '遗迹守卫',
              },
            },
          }
        : { decision: 'abstain' }
    },
  })
  cleanup.push(() => f.close())
  await f.runtime.submit('开始。')
  const view = await act(f, '破甲击')
  const first = structuredClone(game(f))
  expect(first.public.lastResult).toContain('澄使用燃烧火球')
  expect(first.public.lastResult).toContain('守卫攻击')
  expect(first.internal.conditions.some((row: Json) => row.statusId === 'burn')).toBe(true)
  const regenerated = await f.runtime.regenerate(view.tailRound!.id!, randomUUID())
  expect(regenerated.error).toBeFalsy()
  expect(game(f)).toEqual(first)
})
