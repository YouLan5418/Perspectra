import type { StatusSource } from '@harness-world/plugin-sdk'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assembleRoleplay, officialRpgContent } from '../../desktop/official-bundle.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { exportStoryNode, importStoryNode } from '../../desktop/story-share.ts'
import { readStoryNodes, restoreStoryNode } from '../../desktop/story-nodes.ts'
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
  expect(readStoryNodes(data).find(entry => entry.parentNodeId === null)?.files).toContain('plugin-set.json')

  const archive = join(root, 'node.perspectra-story')
  await exportStoryNode(data, node.id, archive, pack)
  const receiver = join(root, 'receiver')
  mkdirSync(receiver)
  const imported = await importStoryNode(archive, receiver, pack, node.packHash)
  expect(imported.node.packHash).toBe(node.packHash)
  expect(imported.node.files).toContain('plugin-set.json')

  // Without the RPG mechanism the generated status module is unknown, and the same node does not preflight.
  const withoutRpg = assembleRoleplay({ content: [] })
  await expect(importStoryNode(archive, receiver, pack, node.packHash, withoutRpg)).rejects.toThrow(
    '需要插件 official-rpg 1',
  )

  const changed = assembleRoleplay({
    content: [
      {
        ...officialRpgContent,
        generate(config, facts) {
          const copy = structuredClone(config) as { skills: { id: string; power: number }[] }
          copy.skills.find(skill => skill.id === 'fire')!.power++
          return officialRpgContent.generate(copy, facts)
        },
      },
    ],
  })
  const mismatch = 'official-rpg 插件生成的规则与存档不一致'
  await expect(importStoryNode(archive, receiver, pack, node.packHash, changed)).rejects.toThrow(mismatch)
  const fork = join(root, 'fork')
  restoreStoryNode(data, node.id, fork, node.packHash)
  await expect(
    WorldHostRuntime.create({
      packPath: pack,
      dataDirectory: fork,
      models: fakeModels(provider.endpoint),
      timeoutMs: 5000,
      composition: changed,
    }),
  ).rejects.toThrow(mismatch)
}, 60_000)

it('the share preflight opens status with the generated rpg module beside the pack status script', async () => {
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
  const node = await runtime.saveNode('带 RPG 与状态脚本的节点')
  await runtime.close()
  const archive = join(root, 'node.perspectra-story')
  await exportStoryNode(data, node.id, archive, pack)

  const opened: (StatusSource | undefined)[] = []
  const composition = assembleRoleplay()
  const status = composition.mechanisms.status!
  const spied = {
    ...composition,
    mechanisms: {
      ...composition.mechanisms,
      status: {
        ...status,
        open: (world: Parameters<typeof status.open>[0], signal: AbortSignal) => {
          opened.push(world.statusSource)
          return status.open(world, signal)
        },
      },
    },
  }
  const receiver = join(root, 'receiver')
  mkdirSync(receiver)
  await importStoryNode(archive, receiver, pack, node.packHash, spied)
  expect(opened).toHaveLength(1)
  expect(opened[0]?.script).toContain('statusScript')
  expect(opened[0]!.modules.map(module => module.id)).toEqual(['rpg'])
  expect(opened[0]!.modules[0]!.source).toContain('install(')
}, 60_000)
