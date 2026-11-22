import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { applyScenario } from '../../apps/host/src/simulation/scenario.ts'
import { LensSimulation } from '../../apps/host/src/simulation/simulation.ts'
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
