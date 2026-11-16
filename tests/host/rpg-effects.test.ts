import { rpgView } from '../support/rpg-stage-view.ts'
import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { openRpgFixture, openRpgWorld, type RpgFixture } from '../support/rpg-fixture.ts'
import { addRpgEffectsExample } from '../support/rpg-effects-fixture.ts'
import { FrontendActions, projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { restoreStoryNode } from '../../apps/host/src/story-nodes.ts'

const fixtures: RpgFixture[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})
async function open() {
  const f = await openRpgFixture({
    config: addRpgEffectsExample,
    places: { 'character:player': 'location:ruin-1', 'character:cheng': 'location:living-room' },
  })
  fixtures.push(f)
  await f.runtime.submit('开始战斗。')
  return f
}
const view = async (f: Pick<RpgFixture, 'runtime'>) => projectPlayerView(await f.runtime.state())
async function perform(f: Pick<RpgFixture, 'runtime'>, label: string, args?: Record<string, string>) {
  const current = await view(f),
    option = current.actions.find(row => row.label === label)!
  return new FrontendActions(f.runtime).perform({
    operation: 'perform',
    actionId: randomUUID(),
    requestId: randomUUID(),
    payload: { optionId: option.id, ...(args ? { arguments: args } : {}) },
  })
}
it('commits shield and periodic state through offered skills; rejected targets neither tick nor spend', async () => {
  const f = await open()
  const shield = await perform(f, '使用技能', { skill: '护盾术', target: '玩家' })
  expect(rpgView(shield)!.units[0]).toMatchObject({ hp: 40, shield: { amount: 4, remaining: 2 } })
  const before = f.events().filter(row => row.eventType === 'activity.updated').length
  await expect(perform(f, '使用技能', { skill: '护盾术', target: '遗迹守卫' })).rejects.toThrow('不能对该目标')
  expect(f.events().filter(row => row.eventType === 'activity.updated')).toHaveLength(before)
  expect(rpgView(await view(f))!.units[0]!.shield).toEqual({ amount: 4, remaining: 2 })
  const poisoned = await perform(f, '使用技能', { skill: '侵蚀术', target: '遗迹守卫' })
  expect(rpgView(poisoned)!.units.find(unit => unit.team === 'enemy')).toMatchObject({
    hp: 46,
    statuses: [{ name: '侵蚀', remaining: 2 }],
  })
  expect(JSON.stringify(rpgView(poisoned))).not.toMatch(/internal|statusId|private|strategy/)
})
it('keeps shields and status durations across activity pause/resume and a saved branch reopen', async () => {
  const f = await open()
  await perform(f, '使用技能', { skill: '再生术', target: '玩家' })
  const current = await perform(f, '使用技能', { skill: '护盾术', target: '玩家' })
  const pause = current.actions.find(row => row.label.startsWith('暂停'))!
  await perform(f, pause.label)
  expect(rpgView(await view(f))).toBeUndefined()
  const paused = await view(f),
    resume = paused.actions.find(row => row.label.startsWith('继续'))!
  const resumed = await perform(f, resume.label)
  expect(rpgView(resumed)!.units).toEqual(rpgView(current)!.units)
  const node = await f.runtime.saveNode('护盾与再生')
  const path = join(f.data, '..', 'effects-branch')
  restoreStoryNode(f.data, node.id, path, node.packHash)
  const branch = await openRpgWorld(f.pack, path)
  try {
    expect(rpgView(await view(branch))!.units).toEqual(rpgView(resumed)!.units)
    for (const world of [f, branch]) await perform(world, '防御')
    expect(rpgView(await view(branch))!.units).toEqual(rpgView(await view(f))!.units)
  } finally {
    await branch.close()
  }
})

it('applies defense and fire resistance before shield, while DoT leaves the one-shot guard for the hit', async () => {
  const f = await openRpgFixture({
    config: c => {
      addRpgEffectsExample(c)
      c.characters['character:player'].defense = 3
      c.equipment['entity:iron-sword'] = { slot: 'weapon', resistances: { fire: 20 } }
      c.combatStatuses.burn = {
        name: '燃烧',
        turns: 3,
        timing: 'after-action',
        polarity: 'negative',
        tick: { kind: 'damage', amount: 3, element: 'fire' },
      }
      c.skills.push({
        id: 'enemy-fire',
        name: '守卫火球',
        target: 'opponent',
        effects: [
          { kind: 'damage', amount: 10, element: 'fire' },
          { kind: 'status', status: 'burn' },
        ],
      })
      c.enemies.golem.attack = 4
      c.enemies.golem.skills = ['enemy-fire']
    },
  })
  fixtures.push(f)
  await f.runtime.submit('/status take@entity:iron-sword {}')
  await f.runtime.submit('/status rpg-equip@entity:iron-sword {}')
  await f.move('location:ruin-1')
  const ward = await perform(f, '使用技能', { skill: '护盾术', target: '玩家' })
  expect(rpgView(ward)!.units[0]).toMatchObject({ hp: 40, shield: { amount: 4, remaining: 2 } })
  const guarded = await perform(f, '防御')
  expect(rpgView(guarded)!.units[0]!.hp).toBe(38)
  expect(rpgView(guarded)!.units[0]!.shield).toBeUndefined()
  expect(rpgView(guarded)!.lastResult).toContain('燃烧造成 2 点伤害')
  expect(rpgView(guarded)!.lastResult).toContain('护盾破碎')
})
