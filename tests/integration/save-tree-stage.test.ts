import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { LauncherCore } from '../../apps/launcher/backend/core.ts'
import { FrontendActions, projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { copyRpgFixture, openRpgWorld } from '../support/rpg-fixture.ts'
import { addRpgValuesExample } from '../support/rpg-values-fixture.ts'
import { rpgView } from '../support/rpg-stage-view.ts'

it('restores the final RPG projection through a complete tree and keeps generic/stage actions on one commit path', async () => {
  const fixture = copyRpgFixture({
    config: addRpgValuesExample,
    places: { 'character:player': 'location:ruin-1', 'character:cheng': 'location:living-room' },
  })
  const source = new LauncherCore(resolve('.'), join(fixture.root, 'source'))
  const target = new LauncherCore(resolve('.'), join(fixture.root, 'target'))
  const opened: Awaited<ReturnType<typeof openRpgWorld>>[] = []
  try {
    for (const core of [source, target]) {
      await core.initialize()
      await core.handle({ operation: 'load', path: fixture.pack })
    }
    const packageId = source.snapshot().packs[0]!.id
    await source.handle({ operation: 'create', packageId, name: '集成保存' })
    const instance = source.snapshot().instances[0]!
    const original = await openRpgWorld(fixture.pack, join(source.root, 'instances', instance.id))
    opened.push(original)
    await original.runtime.submit('开始战斗。')
    const originalActions = new FrontendActions(original.runtime)
    const first = projectPlayerView(await original.runtime.state())
    const shield = first.actions.find(row => row.label === '使用技能')!
    const protectedView = await originalActions.perform({
      operation: 'perform',
      actionId: randomUUID(),
      requestId: randomUUID(),
      payload: { optionId: shield.id, arguments: { skill: '炽热护盾', target: '玩家' } },
    })
    expect(rpgView(protectedView)!.units[0]!.shield).toBeDefined()
    await original.runtime.saveNode('带护盾和作者数值的战斗')
    await original.close()
    const archive = join(fixture.root, 'stage.perspectra-backup')
    await source.handle({ operation: 'tree-backup', instanceId: instance.id, path: archive })
    await target.handle({ operation: 'tree-restore', packageId, path: archive, name: '恢复战斗' })
    const restored = await openRpgWorld(
      fixture.pack,
      join(target.root, 'instances', target.snapshot().instances[0]!.id),
    )
    opened.push(restored)
    const view = projectPlayerView(await restored.runtime.state())
    expect(view.activityStage).toEqual(protectedView.activityStage)
    expect(JSON.stringify(view.activityStage)).not.toMatch(/sourceHash|internal|private|strategy/)
    const actions = new FrontendActions(restored.runtime)
    const skill = view.actions.find(row => row.label === '使用技能')!
    const request = {
      operation: 'perform' as const,
      actionId: randomUUID(),
      requestId: randomUUID(),
      payload: { optionId: skill.id, arguments: { skill: '普通攻击', target: '遗迹守卫' } },
    }
    // Both presentations use this same offered operation; retries must share its authoritative result.
    const [generic, stage] = await Promise.all([actions.perform(request), actions.perform(request)])
    expect(generic.activityStage).toEqual(stage.activityStage)
    expect(rpgView(stage)!.round).toBe(rpgView(view)!.round + 1)
    const events = restored.events().length
    await actions.perform(request)
    expect(restored.events()).toHaveLength(events)
    await expect(actions.perform({ ...request, actionId: randomUUID(), requestId: randomUUID() })).rejects.toThrow()
    expect(restored.events()).toHaveLength(events)
  } finally {
    for (const world of opened.reverse()) await world.close()
    await target.close()
    await source.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
}, 60_000)
