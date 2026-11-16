import { it, expect } from 'vitest'
import { join, resolve } from 'node:path'
import { LauncherCore } from '../../apps/launcher/backend/core.ts'
import { restoreStoryNode } from '../../apps/host/src/story-nodes.ts'
import { openRpgWorld } from '../support/rpg-fixture.ts'
import {
  copyCards,
  startCards,
  chooseCard,
  retryCards,
  committedTable,
  npcChoice,
  object,
  B,
} from '../support/cards-fixture.ts'
it('exports/imports the full tree at aid, forks the same imported node, resolves different answers without event contamination or double fees', async () => {
  const fixture = copyCards()
  const source = new LauncherCore(resolve('.'), join(fixture.root, 'source'))
  const target = new LauncherCore(resolve('.'), join(fixture.root, 'target'))
  const worlds: Awaited<ReturnType<typeof openRpgWorld>>[] = []
  try {
    for (const core of [source, target]) {
      await core.initialize()
      await core.handle({ operation: 'load', path: fixture.pack })
    }
    const packageId = source.snapshot().packs[0]!.id
    await source.handle({ operation: 'create', packageId, name: '牌桌保存树' })
    const data = join(source.root, 'instances', source.snapshot().instances[0]!.id)
    const original = await openRpgWorld(fixture.pack, data, {
      decide: input =>
        input.continuation || object(object(input.context).character).characterId !== B
          ? { decision: 'abstain' }
          : npcChoice(input, 'pass'),
    })
    worlds.push(original)
    await startCards(original, 'identity')
    await chooseCard(original, 'attack:card:0:seat-2')
    expect(committedTable(original).pending!.kind).toBe('aid')
    const saved = committedTable(original)
    const node = await original.runtime.saveNode('同节点求援分叉')
    await original.close()
    const archive = join(fixture.root, 'cards.perspectra-backup')
    await source.handle({ operation: 'tree-backup', instanceId: source.snapshot().instances[0]!.id, path: archive })
    await target.handle({ operation: 'tree-restore', packageId, path: archive, name: '恢复牌桌' })
    const restoredData = join(target.root, 'instances', target.snapshot().instances[0]!.id)
    const restored = await openRpgWorld(fixture.pack, restoredData)
    worlds.push(restored)
    expect(committedTable(restored)).toEqual(saved)
    expect(restored.inputs).toHaveLength(0)
    const finals = []
    for (const choice of ['aid:', 'pass']) {
      const dir = join(fixture.root, 'branch-' + choice.replace(':', ''))
      restoreStoryNode(restoredData, node.id, dir, node.packHash)
      const fork = await openRpgWorld(fixture.pack, dir, {
        decide: input =>
          input.continuation ? { decision: 'abstain' } : npcChoice(input, ids => ids.find(id => id.startsWith(choice))),
      })
      worlds.push(fork)
      await retryCards(fork)
      const table = committedTable(fork)
      expect(table.accepted).toHaveLength(3)
      expect(table.zones.paid!.cards).toEqual([])
      expect(table.zones['hand:seat-1']!.cards).toHaveLength(3)
      finals.push(table)
    }
    expect((finals[0]!.data.hp as Record<string, number>)['seat-2']).toBe(2)
    expect((finals[1]!.data.hp as Record<string, number>)['seat-2']).toBe(1)
    expect(finals[0]!.data.lastTrace).toContain('20:aid-reduce')
    expect(finals[1]!.data.lastTrace).not.toContain('20:aid-reduce')
    expect(committedTable(restored)).toEqual(saved)
  } finally {
    for (const world of worlds.reverse()) await world.close()
    await target.close()
    await source.close()
    fixture.cleanup()
  }
}, 60_000)
