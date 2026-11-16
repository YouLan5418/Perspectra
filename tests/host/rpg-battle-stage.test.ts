import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { FrontendActions, projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { openRpgFixture, type RpgFixture } from '../support/rpg-fixture.ts'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { officialRpgBattleView } from '@perspectra/plugins/rpg'
import type { ActivityHooks } from '@perspectra/sdk'

const opened: RpgFixture[] = []
afterEach(async () => {
  for (const f of opened.splice(0)) await f.close()
})
async function battle(hp = 50) {
  const f = await openRpgFixture({
    config: config => {
      for (const map of config.maps) map.scripted = []
      config.enemies.golem.hp = hp
    },
    places: { 'character:player': 'location:ruin-1', 'character:cheng': 'location:ruin-1' },
    decide: input => {
      const context = input.context as WorldJsonObject,
        activity = context.activity as WorldJsonObject | undefined
      const actor = (context.character as WorldJsonObject).characterId
      const game = activity?.game as WorldJsonObject | undefined
      return game?.phase === 'fighting' && game.turn === actor && !input.continuation
        ? {
            decision: 'perform',
            actionType: 'interact',
            parameters: {
              targetRef: { kind: 'character', id: actor },
              bindingId: activity!.id,
              definitionRef: { id: 'activity:guard', version: 1 },
              arguments: { activityId: activity!.id, revision: activity!.revision },
            },
          }
        : { decision: 'abstain' }
    },
  })
  opened.push(f)
  await f.runtime.submit('准备战斗。')
  return { ...f, actions: new FrontendActions(f.runtime), view: async () => projectPlayerView(await f.runtime.state()) }
}
const request = (optionId: string, args?: WorldJsonObject) => ({
  requestId: randomUUID(),
  actionId: randomUUID(),
  operation: 'perform' as const,
  payload: { optionId, ...(args ? { arguments: args } : {}) },
})

it('projects official player combat only and uses the real deduplicated perform/commit path', async () => {
  const f = await battle(),
    before = await f.view()
  expect(before.battle).toMatchObject({ kind: 'official-rpg-battle', round: 1, turn: 'character:player' })
  expect(before.battle!.units.find(unit => unit.team === 'enemy')!.hp).toBe(50)
  expect(before.battle!.skills.find(skill => skill.name === '普通攻击')!.targets).toEqual(['遗迹守卫'])
  expect(before.battle!.skills.find(skill => skill.name === '治疗术')!.targets).toEqual([])
  expect(JSON.stringify(before.battle)).not.toMatch(/internal|private|strategy|pending|conditions/)
  const skill = before.actions.find(
    option => option.argumentSchema?.properties && 'skill' in (option.argumentSchema.properties as WorldJsonObject),
  )!
  const input = request(skill.id, { skill: '普通攻击', target: '遗迹守卫' })
  const [left, right] = await Promise.all([f.actions.perform(input), f.actions.perform(input)])
  expect(left.battle).toEqual(right.battle)
  expect(left.battle!.round).toBe(2)
  expect(left.battle!.units.find(unit => unit.team === 'enemy')!.hp).toBeLessThan(50)
  expect(left.battle!.revision).toBeGreaterThan(before.battle!.revision)
  const count = f.events().length
  await f.actions.perform(input)
  expect(f.events().length).toBe(count)
  await expect(f.actions.perform(request(skill.id, { skill: '普通攻击', target: '遗迹守卫' }))).rejects.toThrow()
  expect(f.events().length).toBe(count)
  const committed = (await f.runtime.state()).activity!.game as WorldJsonObject
  expect(left.battle!.units.map(unit => unit.hp)).toEqual(
    (committed.public as WorldJsonObject).units instanceof Array
      ? ((committed.public as WorldJsonObject).units as WorldJsonObject[]).map(unit => unit.hp)
      : [],
  )
})

it('returns to generic presentation on suspension and escape without resetting progress', async () => {
  const f = await battle(),
    before = await f.view()
  const suspend = before.actions.find(option => option.kind === 'manage' && option.label.startsWith('暂停'))!
  const paused = await f.actions.perform(request(suspend.id))
  expect(paused.battle).toBeUndefined()
  const resume = paused.actions.find(option => option.label.startsWith('继续'))!
  const resumed = await f.actions.perform(request(resume.id))
  expect(resumed.battle!.activityId).toBe(before.battle!.activityId)
  expect(resumed.battle!.units).toEqual(before.battle!.units)
  await f.runtime.escape()
  expect((await f.view()).battle).toBeUndefined()
})

it('removes the battle projection after a real finishing hit', async () => {
  const f = await battle(5),
    before = await f.view()
  const skill = before.actions.find(
    option => option.argumentSchema?.properties && 'skill' in (option.argumentSchema.properties as WorldJsonObject),
  )!
  const after = await f.actions.perform(request(skill.id, { skill: '普通攻击', target: '遗迹守卫' }))
  expect(after.battle).toBeUndefined()
  expect(f.events().some(event => event.eventType === 'activity.updated')).toBe(true)
})

it('does not recognize an activity by its claimed name, key or lookalike fields', () => {
  expect(
    officialRpgBattleView(
      {} as ActivityHooks,
      {
        activityKey: 'rpg-map-ruin-1',
        title: '官方 RPG 战斗',
        id: 'activity:fake',
        revision: 1,
        game: { active: true, phase: 'fighting', public: { units: [] } },
      },
      'character:player',
      ['character:player'],
    ),
  ).toBeUndefined()
})
