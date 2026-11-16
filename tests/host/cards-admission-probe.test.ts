import { it, expect } from 'vitest'
import { join } from 'node:path'
import { openStageLab, labGenerator } from '../support/activity-stage-fixture.ts'
import { openRpgWorld } from '../support/rpg-fixture.ts'
import { restoreStoryNode } from '../../apps/host/src/story-nodes.ts'
import { assembleRoleplay } from '../../apps/host/src/official-bundle.ts'
import { projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'

// Discovery probe: generic Activity id/revision alone does not distinguish a restored clone.
// Cards must add an adapter-scoped operation identity; changing core is unnecessary.
it('records the generic cloned-Activity admission limitation before cards add instance binding', async () => {
  const f = await openStageLab()
  let fork: Awaited<ReturnType<typeof openRpgWorld>> | undefined
  try {
    const start = projectPlayerView(await f.runtime.state()).actions.find(a => a.label.startsWith('开始 登记实验'))!
    await f.runtime.perform(start.action)
    const offered = projectPlayerView(await f.runtime.state()).actions.find(a => a.label === '增加计数')!
    const node = await f.runtime.saveNode('probe')
    const dir = join(f.data, '..', 'probe-fork')
    restoreStoryNode(f.data, node.id, dir, node.packHash)
    fork = await openRpgWorld(f.pack, dir, { composition: assembleRoleplay({ content: [labGenerator()] }) })
    await fork.runtime.perform(offered.action)
    expect(
      ((await fork.runtime.state()).activity!.game as import('@perspectra/sdk/contracts').WorldJsonObject).public,
    ).toEqual({ count: 1, title: '登记实验' })
  } finally {
    await fork?.close()
    await f.close()
  }
})
