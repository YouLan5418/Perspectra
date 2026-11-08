import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assembleRoleplay } from '../../desktop/official-bundle.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { exportStoryNode, importStoryNode } from '../../desktop/story-share.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'
import { copyRpgFixture } from '../support/rpg-fixture.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('sharing a story node of an rpg.json pack preflights with the generated status module', async () => {
  const { root, pack, data } = copyRpgFixture()
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const provider = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  cleanups.push(() => provider.close())
  const runtime = await WorldHostRuntime.create({
    packPath: pack,
    dataDirectory: data,
    models: fakeModels(provider.endpoint),
    timeoutMs: 5000,
    storyNodes: true,
  })
  const node = await runtime.saveNode('带 RPG 的节点')
  await runtime.close()

  const archive = join(root, 'node.perspectra-story')
  await exportStoryNode(data, node.id, archive, pack)
  const receiver = join(root, 'receiver')
  mkdirSync(receiver)
  const imported = await importStoryNode(archive, receiver, pack, node.packHash)
  expect(imported.node.packHash).toBe(node.packHash)

  // Without the RPG mechanism the generated status module is unknown, and the same node does not preflight.
  const { rpg: _, ...withoutRpg } = assembleRoleplay()
  await expect(importStoryNode(archive, receiver, pack, node.packHash, withoutRpg)).rejects.toThrow('RPG 插件')
}, 60_000)
