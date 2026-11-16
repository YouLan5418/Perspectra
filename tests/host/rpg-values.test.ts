import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { restoreStoryNode } from '../../apps/host/src/story-nodes.ts'
import { addRpgValuesExample } from '../support/rpg-values-fixture.ts'
import { openRpgFixture, openRpgWorld, type RpgFixture } from '../support/rpg-fixture.ts'
import { FrontendActions, projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
type Json = Record<string, any>
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const game = (f: RpgFixture) => (f.events().findLast(e => e.eventType === 'activity.updated')!.data as Json).state.game
async function act(f: RpgFixture, skill: string, target = '遗迹守卫') {
  const view = projectPlayerView(await f.runtime.state()),
    offered = view.actions.find(a => a.label === '使用技能')!
  return new FrontendActions(f.runtime).perform({
    requestId: randomUUID(),
    actionId: randomUUID(),
    operation: 'perform',
    payload: { optionId: offered.id, arguments: { skill, target } },
  })
}
it('commits authored values, rejects unaffordable/invalid/stale requests, projects one authorized state and replays deterministically', async () => {
  const f = await openRpgFixture({
    config: addRpgValuesExample,
    places: { 'character:player': 'location:ruin-1', 'character:cheng': 'location:living-room' },
  })
  cleanup.push(() => f.close())
  await f.runtime.submit('开始。')
  const start = projectPlayerView(await f.runtime.state()),
    before = structuredClone(game(f)),
    old = start.actions.find(a => a.label === '使用技能')!
  expect(start.battle?.skills.find(s => s.name === '怒击')?.unavailable).toBe('怒气不足')
  await expect(act(f, '怒击')).rejects.toThrow()
  expect(game(f)).toEqual(before)
  await act(f, '压制')
  await act(f, '压制')
  expect(game(f).internal.values.units['character:player'].rage).toBe(6)
  expect(game(f).internal.values.units.golem.posture).toBe(0)
  expect(game(f).internal.values.units['character:player'].posture).toBe(4)
  const eligible = projectPlayerView(await f.runtime.state())
  expect(eligible.battle?.skills.find(s => s.name === '怒击')?.unavailable).toBeUndefined()
  const snapshot = structuredClone(game(f))
  await expect(act(f, '怒击', '玩家')).rejects.toThrow()
  expect(game(f)).toEqual(snapshot)
  await expect(
    new FrontendActions(f.runtime).perform({
      requestId: randomUUID(),
      actionId: randomUUID(),
      operation: 'perform',
      payload: { optionId: old.id, arguments: { skill: '压制', target: '遗迹守卫' } },
    }),
  ).rejects.toThrow()
  expect(game(f)).toEqual(snapshot)
  const result = await act(f, '怒击'),
    committed = structuredClone(game(f))
  expect(committed.internal.values.units['character:player'].rage).toBe(4)
  expect(committed.internal.conditions.find((c: Json) => c.statusId === 'broken').remaining).toBe(1)
  const projected = result.battle!
  for (const unit of projected.units) {
    const numbers = committed.public.battleValues.units.find((row: Json) => row.unitId === unit.id)
    expect(unit.resources).toEqual(numbers.resources)
    expect(unit.attributes).toEqual(numbers.attributes)
  }
  expect(projected.sharedValues).toEqual(committed.public.battleValues.shared)
  expect(JSON.stringify(projected)).not.toContain('onZeroStatus')
  expect(JSON.stringify(projected)).not.toContain('onHpLoss')
  await act(f, '唤雨', '玩家')
  expect(game(f).internal.values.shared.rain).toBe(5)
  const hp = game(f).public.units.find((u: Json) => u.id === 'golem').hp
  const last = await act(f, '雨中火球')
  expect(game(f).public.units.find((u: Json) => u.id === 'golem').hp).toBeLessThan(hp)
  const final = structuredClone(game(f))
  const replay = await f.runtime.regenerate(last.tailRound!.id!, randomUUID())
  expect(replay.error).toBeFalsy()
  expect(game(f)).toEqual(final)
}, 60_000)
it('NPCs and enemies use the same resource effects/cost chain and host RNG replay', async () => {
  const f = await openRpgFixture({
    config: c => {
      const companion = structuredClone(c.characters['character:cheng'])
      addRpgValuesExample(c)
      c.characters['character:cheng'] = companion
      companion.skills.push('pressure')
      c.enemies.golem.skills = ['rage-strike', 'enemy-strike']
      c.enemies.golem.strategy = 'random'
    },
    places: { 'character:player': 'location:ruin-1', 'character:cheng': 'location:ruin-1' },
    decide: input => {
      const a = (input.context as Json).activity
      return a?.game.turn === 'character:cheng' && !input.continuation
        ? {
            decision: 'perform',
            actionType: 'interact',
            parameters: {
              targetRef: { kind: 'character', id: 'character:cheng' },
              bindingId: a.id,
              definitionRef: { id: 'activity:skill', version: 1 },
              arguments: { activityId: a.id, revision: a.revision, skill: '压制', target: '遗迹守卫' },
            },
          }
        : { decision: 'abstain' }
    },
  })
  cleanup.push(() => f.close())
  await f.runtime.submit('开始。')
  const view = await act(f, '压制'),
    first = structuredClone(game(f))
  expect(first.public.lastResult).toContain('澄使用压制')
  expect(first.public.lastResult).toContain('遗迹守卫使用怒击')
  expect(first.internal.values.units.golem.rage).toBe(1)
  expect(first.internal.values.units.golem.posture).toBe(0)
  expect(first.internal.values.units['character:player']).not.toBe(first.internal.values.units['character:cheng'])
  expect(
    [first.internal.values.units['character:player'].rage, first.internal.values.units['character:cheng'].rage].sort(),
  ).toEqual([0, 3])
  const replay = await f.runtime.regenerate(view.tailRound!.id!, randomUUID())
  expect(replay.error).toBeFalsy()
  expect(game(f)).toEqual(first)
}, 60_000)

it('preserves authored values over pause/resume and a real saved branch reopen', async () => {
  const f = await openRpgFixture({
    config: addRpgValuesExample,
    places: { 'character:player': 'location:ruin-1', 'character:cheng': 'location:living-room' },
  })
  cleanup.push(() => f.close())
  await f.runtime.submit('开始。')
  await act(f, '压制')
  const before = await act(f, '唤雨', '玩家')
  const perform = async (world: Pick<RpgFixture, 'runtime'>, label: string) => {
    const view = projectPlayerView(await world.runtime.state()),
      option = view.actions.find(row => row.label.startsWith(label))!
    return new FrontendActions(world.runtime).perform({
      requestId: randomUUID(),
      actionId: randomUUID(),
      operation: 'perform',
      payload: { optionId: option.id },
    })
  }
  expect((await perform(f, '暂停')).battle).toBeUndefined()
  const resumed = await perform(f, '继续')
  expect(resumed.battle!.units).toEqual(before.battle!.units)
  expect(resumed.battle!.sharedValues).toEqual(before.battle!.sharedValues)
  const node = await f.runtime.saveNode('活动内数值'),
    path = join(f.data, '..', 'values-branch')
  restoreStoryNode(f.data, node.id, path, node.packHash)
  const branch = await openRpgWorld(f.pack, path)
  try {
    const restored = projectPlayerView(await branch.runtime.state())
    expect(restored.battle!.units).toEqual(resumed.battle!.units)
    expect(restored.battle!.sharedValues).toEqual(resumed.battle!.sharedValues)
    const a = await perform(f, '防御'),
      b = await perform(branch, '防御')
    expect(a.battle!.units).toEqual(b.battle!.units)
    expect(a.battle!.sharedValues).toEqual(b.battle!.sharedValues)
  } finally {
    await branch.close()
  }
}, 60_000)
