import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { applyScenario } from '../../desktop/lens/scenario.ts'
import { LensSimulation } from '../../desktop/lens/simulation.ts'
import { buildLensView, type LensItem } from '../../desktop/lens/view.ts'
import { copyRpgFixture } from '../support/rpg-fixture.ts'

const PLAYER = 'character:player',
  CHENG = 'character:cheng',
  ARU = 'character:aru'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
/** A lens simulation of a temporary copy of the RPG fixture pack. */
async function openLens(
  options: Parameters<typeof copyRpgFixture>[0] = {},
  start: Parameters<typeof LensSimulation.open>[1] = {},
) {
  const { root, pack } = copyRpgFixture(options)
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const lens = await LensSimulation.open(pack, start)
  cleanups.push(() => lens.close())
  return { lens, pack }
}
/** A one-hit golem and no scripted lines, so one strike ends the ruin-1 battle. */
const weakGolem = (c: Record<string, any>) => {
  c.maps[0].scripted = []
  c.enemies.golem.hp = 5
}

describe('the lens and rpg.json', () => {
  it('lens view lists RPG characters, enemies and map exits with their conditions', async () => {
    const { lens, pack } = await openLens()
    const view = await buildLensView(pack, lens)
    const item = (id: string): LensItem => {
      const found = view.items.find(candidate => candidate.id === id)
      if (!found) throw new Error('missing item ' + id)
      return found
    }
    const field = (id: string, key: string) => item(id).fields.find(candidate => candidate.key === key)?.value
    expect(view.items.filter(i => i.section === 'rpg').every(i => i.id.startsWith('rpg:'))).toBe(true)

    expect(field('rpg:character/character:cheng', 'skills')).toEqual(['普通攻击', '火球术', '治疗术'])
    expect(field('rpg:character/character:cheng', 'stats')).toEqual(['生命 30', '魔力 12'])
    expect(field('rpg:enemy/golem', 'encounter')).toBe('擅入者，止步。')
    expect(field('rpg:enemy/golem', 'defeated')).toBe('你们……终究还是来了。')
    expect(field('rpg:equipment/entity:iron-sword', 'attack')).toBe(3)
    expect(field('rpg:consumable/entity:potion', 'restore')).toEqual(['生命 20'])
    expect(field('rpg:map/location:ruin-1', 'narration')).toBe('潮湿的石廊，尽头有一扇铁门。')
    expect(field('rpg:map/location:ruin-1', 'enemies')).toEqual(['遗迹守卫'])
    const exit = item('rpg:map/location:ruin-1/exit/location:ruin-2')
    expect(exit.parentId).toBe('rpg:map/location:ruin-1')
    expect(exit.fields.find(f => f.key === 'lockedReason')?.value).toBe('铁门锁着，需要钥匙。')
    expect(String(exit.fields.find(f => f.key === 'requires')?.value)).toContain('铁钥匙')
    expect(exit.source).toEqual({ kind: 'json', file: 'rpg.json', pointer: '/maps/0/exits/0' })
    expect(field('rpg:settings', 'lockDuringBattle')).toBe(true)
    // The generated map event is listed with rpg.json as its source, not a script that does not exist.
    expect(item('event:rpg-map-ruin-1').source).toEqual({ kind: 'json', file: 'rpg.json', pointer: '/maps/0' })
  }, 60_000)

  it('a lens scenario can fight the ruin-1 battle and expect Ah-Ru at home not to know the golem fell', async () => {
    const { lens } = await openLens({ config: weakGolem }, { scenes: { [CHENG]: 'scene:ruin-1' } })
    const result = await applyScenario(lens, {
      title: '遗迹守卫倒下',
      steps: [
        { move: 'location:ruin-1' },
        {
          activity: 'rpg-map-ruin-1',
          operation: 'skill',
          parameters: { skill: '普通攻击', target: '遗迹守卫' },
          expect: {
            knows: { [PLAYER]: '遗迹守卫', [CHENG]: '遗迹守卫' },
            doesNotKnow: { [ARU]: ['遗迹守卫', '你们……终究还是来了'] },
          },
        },
      ],
    })
    expect(result.steps.map(step => step.error)).toEqual([undefined, undefined])
    expect(result.steps[1]!.expectations?.every(e => e.ok)).toBe(true)
    expect(result.steps[1]!.expectations).toHaveLength(4)
    expect(result.passed).toBe(true)
  }, 60_000)

  it('the locked door refuses passage in the lens simulation while the key lies on the floor', async () => {
    const { lens } = await openLens({ config: weakGolem }, { scenes: { [CHENG]: 'scene:ruin-1' } })
    const result = await applyScenario(lens, {
      title: '铁门',
      steps: [
        { move: 'location:ruin-1' },
        {
          activity: 'rpg-map-ruin-1',
          operation: 'skill',
          parameters: { skill: '普通攻击', target: '遗迹守卫' },
        },
        { move: 'location:ruin-2' },
      ],
    })
    const refused = result.steps[2]!
    expect(JSON.stringify(refused)).toContain('铁门锁着，需要钥匙。')
    expect(refused.lines.some(line => line.kind === 'moved')).toBe(false)
    expect((await lens.state()).world.currentScene?.locationName).toBe('遗迹一层')
  }, 60_000)

  it('skipAutoStart accepts a generated map activity: entering ruin-1 then starts no battle', async () => {
    const enter = {
      kind: 'action',
      action: { actionType: 'move', parameters: { locationId: 'location:ruin-1' } },
    } as const
    const normal = await openLens({}, { scenes: { [CHENG]: 'scene:ruin-1' } })
    const started = await normal.lens.step(enter)
    expect(started.autoStart.find(e => e.activityKey === 'rpg-map-ruin-1')?.started).toBe(true)

    const skipped = await openLens({}, { scenes: { [CHENG]: 'scene:ruin-1' }, skipAutoStart: ['rpg-map-ruin-1'] })
    const trace = await skipped.lens.step(enter)
    expect(trace.error).toBeUndefined()
    expect(trace.autoStart.find(e => e.activityKey === 'rpg-map-ruin-1')?.started).not.toBe(true)
    await expect(
      LensSimulation.open('tests/fixtures/rpg-pack', { skipAutoStart: ['rpg-map-nowhere'] }),
    ).rejects.toThrow('未知活动 rpg-map-nowhere')
  }, 60_000)
})
