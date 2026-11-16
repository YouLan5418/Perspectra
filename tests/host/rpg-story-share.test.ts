import type { StatusSource } from '@perspectra/sdk'
import { mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assembleRoleplay, officialRpgContent } from '../../apps/host/src/official-bundle.ts'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { exportStoryNode, importStoryNode } from '../../apps/host/src/story-share.ts'
import { readStoryNodes, restoreStoryNode } from '../../apps/host/src/story-nodes.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'
import { copyRpgFixture } from '../support/rpg-fixture.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('sharing a story node of an rpg.json pack preflights with persistent data compatibility', async () => {
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
  const missing = JSON.parse(readFileSync(archive, 'utf8'))
  missing.node.files = missing.node.files.filter((name: string) => name !== 'plugin-set.json')
  delete missing.files['plugin-set.json']
  const missingArchive = join(root, 'missing-record.perspectra-story')
  writeFileSync(missingArchive, JSON.stringify(missing))
  const before = readdirSync(receiver)
  await expect(importStoryNode(missingArchive, receiver, pack, node.packHash)).rejects.toThrow('缺少 plugin-set.json')
  expect(readdirSync(receiver)).toEqual(before)

  const withoutRpg = assembleRoleplay({ content: [] })
  await expect(importStoryNode(archive, receiver, pack, node.packHash, withoutRpg)).rejects.toThrow(
    'Selected plugin is not installed or allowed: official-rpg',
  )

  // 兼容数值调整允许正常导入分享节点与恢复故事线。
  const compatible = assembleRoleplay({
    content: [
      {
        ...officialRpgContent,
        identity: { firePowerBonus: 1 },
        generate(config, facts) {
          const copy = structuredClone(config) as { skills: { id: string; power: number }[] }
          copy.skills.find(skill => skill.id === 'fire')!.power++
          return officialRpgContent.generate(copy, facts)
        },
      },
    ],
  })
  const compatibleReceiver = join(root, 'compatible-receiver')
  mkdirSync(compatibleReceiver)
  const importedCompatible = await importStoryNode(archive, compatibleReceiver, pack, node.packHash, compatible)
  expect(importedCompatible.node.packHash).toBe(node.packHash)
  const compatibleFork = join(root, 'compatible-fork')
  restoreStoryNode(data, node.id, compatibleFork, node.packHash)
  const reopenedCompatible = await WorldHostRuntime.create({
    packPath: pack,
    dataDirectory: compatibleFork,
    models: fakeModels(provider.endpoint),
    timeoutMs: 5000,
    composition: compatible,
  })
  await reopenedCompatible.close()

  // 不兼容 dataVersion 明确拒绝导入和开档。
  const incompatible = assembleRoleplay({
    content: [
      {
        ...officialRpgContent,
        dataVersion: 2,
        supportedDataVersions: [2],
      },
    ],
  })
  const mismatch = 'official-rpg 插件的数据版本与存档不兼容（存档 dataVersion 1，当前支持 2）'
  await expect(importStoryNode(archive, receiver, pack, node.packHash, incompatible)).rejects.toThrow(mismatch)
  const fork = join(root, 'fork')
  restoreStoryNode(data, node.id, fork, node.packHash)
  await expect(
    WorldHostRuntime.create({
      packPath: pack,
      dataDirectory: fork,
      models: fakeModels(provider.endpoint),
      timeoutMs: 5000,
      composition: incompatible,
    }),
  ).rejects.toThrow(mismatch)
}, 60_000)

it('the share preflight opens status with the native rpg module beside the pack status script', async () => {
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
  expect('module' in opened[0]!.modules[0]!).toBe(true)
}, 60_000)
