import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  renameSync,
  watch,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LauncherCore } from '../../apps/launcher/backend/core.ts'
import { addRpgEffectsExample } from '../support/rpg-effects-fixture.ts'
import { rpgView } from '../support/rpg-stage-view.ts'
import { FrontendActions, projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { copyRpgFixture } from '../support/rpg-fixture.ts'
import { createRuntimeWithCore } from '../support/core-memory-options.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'
import { backupLineDirectory } from '../../apps/host/src/story-backup.ts'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  vi.restoreAllMocks()
})
function files(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const path = join(e.parentPath, e.name)
        return [path.slice(root.length), createHash('sha256').update(readFileSync(path)).digest('hex')]
      }),
  )
}
async function setup() {
  const f = copyRpgFixture({ config: addRpgEffectsExample, places: { 'character:aru': 'location:bedroom' } })
  cleanup.push(() => rmSync(f.root, { recursive: true, force: true }))
  const source = new LauncherCore(resolve('.'), join(f.root, 'source'))
  const receiver = new LauncherCore(resolve('.'), join(f.root, 'receiver'))
  await source.initialize()
  await receiver.initialize()
  cleanup.push(() => source.close())
  cleanup.push(() => receiver.close())
  for (const core of [source, receiver]) await core.handle({ operation: 'load', path: f.pack })
  const packageId = source.snapshot().packs[0]!.id
  await source.handle({ operation: 'create', packageId, name: '树' })
  const instance = source.snapshot().instances[0]!,
    instanceId = instance.id
  const root = join(source.root, 'instances', instanceId)
  let modelCalls = 0,
    memoryCalls = 0
  const provider = await startFakeProvider('openai', () => {
    modelCalls++
    return { tool: { decision: 'abstain' } }
  })
  cleanup.push(() => provider.close())
  async function open(directory: string, parent?: string) {
    const run = async (input: WorldJsonObject): Promise<WorldJsonObject> => {
      memoryCalls++
      return input.operation === 'build'
        ? {
            archive: { scope: input.scope!, sources: input.sources!, facts: [], episodes: [], observations: [] },
            index: { scope: input.scope!, units: [], vectors: [] },
          }
        : { delivery: [], deliveryTrace: { delivered: [], activityCoverage: [] } }
    }
    const runtime = await createRuntimeWithCore({
      packPath: f.pack,
      dataDirectory: directory,
      models: fakeModels(provider.endpoint),
      timeoutMs: 5000,
      ...(parent ? { storyParentNodeId: parent } : {}),
      memoryCore: true,
      memoryCoreRun: run,
      memoryCoreBuildRun: run,
    })
    cleanup.push(() => runtime.close())
    return runtime
  }
  const main = await open(root)
  await main.submit('这是共同的起点。')
  await main.refreshMemory()
  await main.waitForMemory()
  const start = await main.saveNode('共同起点')
  const duplicate = await main.saveNode('相同快照')
  await main.close()
  // Exact-byte duplicate fixture: ordinary repeated saves may differ in SQLite lease bookkeeping.
  copyFileSync(
    join(root, 'story-nodes', start.id, 'world.sqlite'),
    join(root, 'story-nodes', duplicate.id, 'world.sqlite'),
  )
  const branches: {
    id: string
    node: typeof start
    latest: typeof start
    marker: string
    battle: ReturnType<typeof rpgView>
  }[] = []
  for (const marker of ['红色秘密', '蓝色秘密']) {
    await source.handle({ operation: 'story-select', instanceId, storylineId: 'main' })
    await source.handle({ operation: 'story-fork', instanceId, nodeId: start.id, name: marker })
    const line = source.snapshot().instances[0]!.currentStorylineId
    const runtime = await open(backupLineDirectory(root, line), start.id)
    await runtime.submit(marker)
    await runtime.refreshMemory()
    await runtime.waitForMemory()
    const node = await runtime.saveNode(marker)
    await runtime.submit('/act move {"locationId":"location:ruin-1"}')
    const view = projectPlayerView(await runtime.state())
    const skill = view.actions.find(row => row.label === '使用技能')!
    const result = await new FrontendActions(runtime).perform({
      operation: 'perform',
      requestId: randomUUID(),
      actionId: randomUUID(),
      payload: {
        optionId: skill.id,
        arguments:
          marker === '红色秘密' ? { skill: '护盾术', target: '玩家' } : { skill: '侵蚀术', target: '遗迹守卫' },
      },
    })
    const latest = await runtime.saveNode('战斗进度')
    await runtime.close()
    branches.push({ id: line, node, latest, marker, battle: rpgView(result) })
  }
  await source.handle({ operation: 'story-fork', instanceId, nodeId: branches[1]!.node.id, name: '未另存的旁支' })
  const archive = join(f.root, 'tree.perspectra-backup')
  writeFileSync(join(root, 'requests.jsonl'), 'DIAGNOSTIC_NOT_IN_BACKUP')
  writeFileSync(join(root, 'credentials.json'), 'CREDENTIAL_FIXTURE_NOT_IN_BACKUP')
  mkdirSync(join(root, 'story-nodes', '.orphan'))
  writeFileSync(join(root, 'story-nodes', '.orphan', 'unfinished'), 'ORPHAN_NOT_IN_BACKUP')
  const before = files(root),
    calls = () => [modelCalls, memoryCalls]
  const oldCalls = calls()
  await source.handle({ operation: 'tree-backup', instanceId, path: archive })
  expect(calls()).toEqual(oldCalls)
  expect(files(root)).toEqual(before)
  return {
    ...f,
    source,
    receiver,
    instanceId,
    packageId,
    root,
    archive,
    branches,
    before,
    calls,
    open,
    start,
    duplicate,
  }
}

it('Launcher round-trips the saved tree across data roots with dedup, exact memory and independent old-node continuation', async () => {
  const f = await setup()
  const raw = JSON.parse(readFileSync(f.archive, 'utf8'))
  expect(f.branches[0]!.node.headSeq).toBe(f.branches[1]!.node.headSeq)
  expect(readFileSync(f.archive, 'utf8')).not.toMatch(
    /DIAGNOSTIC_NOT_IN_BACKUP|CREDENTIAL_FIXTURE_NOT_IN_BACKUP|ORPHAN_NOT_IN_BACKUP/,
  )
  expect(
    raw.nodes.every((e: any) => !e.node.files.includes('context.sqlite') && !e.node.files.includes('memory.sqlite')),
  ).toBe(true)
  const refs = raw.nodes.flatMap((e: any) => Object.values(e.objects))
  expect(raw.objects.length).toBeLessThan(refs.length)
  const a = raw.nodes.find((e: any) => e.node.id === f.start.id),
    b = raw.nodes.find((e: any) => e.node.id === f.duplicate.id)
  expect(a.objects['core-memory.json']).toBe(b.objects['core-memory.json'])
  expect(a.objects['world.sqlite']).toBe(b.objects['world.sqlite'])
  const branchArchives = f.branches.map(
    branch => raw.nodes.find((e: any) => e.node.id === branch.node.id).objects['core-memory.json'],
  )
  expect(branchArchives[0]).not.toBe(branchArchives[1])
  const oldCalls = f.calls()
  await f.receiver.handle({ operation: 'tree-restore', packageId: f.packageId, path: f.archive, name: '恢复' })
  expect(f.calls()).toEqual(oldCalls)
  const restored = f.receiver.snapshot().instances[0]!
  expect(restored.storylines).toEqual(f.source.snapshot().instances[0]!.storylines)
  expect(restored.currentStorylineId).toBe(f.source.snapshot().instances[0]!.currentStorylineId)
  const dest = join(f.receiver.root, 'instances', restored.id)
  for (const branch of f.branches) {
    const current = await f.open(backupLineDirectory(dest, branch.id), branch.node.id)
    expect(rpgView(projectPlayerView(await current.state()))!.units).toEqual(branch.battle!.units)
    await current.close()
    const original = join(backupLineDirectory(f.root, branch.id), 'story-nodes', branch.node.id)
    const copied = join(backupLineDirectory(dest, branch.id), 'story-nodes', branch.node.id)
    for (const file of raw.nodes.find((e: any) => e.node.id === branch.node.id).node.files)
      expect(readFileSync(join(copied, file))).toEqual(readFileSync(join(original, file)))
    const memory = JSON.parse(readFileSync(join(copied, 'core-memory.json'), 'utf8'))
    expect(JSON.stringify(memory['character:cheng'])).toContain(branch.marker)
    expect(JSON.stringify(memory['character:aru'])).not.toContain(branch.marker)
    await f.receiver.handle({ operation: 'story-select', instanceId: restored.id, storylineId: branch.id })
    await f.receiver.handle({
      operation: 'story-fork',
      instanceId: restored.id,
      nodeId: branch.node.id,
      name: '独立续玩',
    })
    const fork = f.receiver.snapshot().instances[0]!.currentStorylineId
    const runtime = await f.open(backupLineDirectory(dest, fork), branch.node.id)
    await runtime.submit('继续' + branch.marker)
    const saved = await runtime.saveNode('续玩节点')
    expect(saved.parentNodeId).toBe(branch.node.id)
    expect(saved.headSeq).toBeGreaterThan(branch.node.headSeq)
    await runtime.close()
  }
  expect(files(f.root)).toEqual(f.before)
  await f.receiver.handle({ operation: 'tree-restore', packageId: f.packageId, path: f.archive, name: '再次恢复' })
  expect(f.receiver.snapshot().instances).toHaveLength(2)
  expect(f.receiver.snapshot().instances[1]!.id).not.toBe(restored.id)
  // Single-node sharing remains its own format and uses the original endpoint.
  await f.source.handle({ operation: 'story-select', instanceId: f.instanceId, storylineId: 'main' })
  const single = join(f.root, '..', 'single.perspectra-story')
  await f.source.handle({ operation: 'story-export', instanceId: f.instanceId, nodeId: f.start.id, path: single })
  await f.receiver.handle({ operation: 'story-import', packageId: f.packageId, path: single, name: '单节点' })
  expect(f.receiver.snapshot().instances).toHaveLength(3)
}, 120_000)

it('rejects missing/corrupt objects, bad ancestry, foreign archives and incompatible providers before publishing', async () => {
  const f = await setup(),
    original = JSON.parse(readFileSync(f.archive, 'utf8'))
  const replace = (b: any, entry: any, file: string, bytes: Buffer) => {
    const h = createHash('sha256').update(bytes).digest('hex')
    entry.objects[file] = h
    b.objects.push({ hash: h, size: bytes.length, data: bytes.toString('base64') })
    const refs = new Set(b.nodes.flatMap((e: any) => Object.values(e.objects)))
    b.objects = b.objects.filter((o: any) => refs.has(o.hash))
  }
  const cases: ((b: any) => void)[] = [
    b => {
      b.objects[0].size = -1
    },
    b => {
      b.objects[0].size = 64 * 1024 * 1024 + 1
    },
    b => {
      b.tree.storylines = Array(65).fill(b.tree.storylines[0])
    },
    b => {
      b.nodes = Array(257).fill(b.nodes[0])
    },
    b => {
      b.nodes[0].objects['world.sqlite'] = '../escape'
    },
    b => {
      const entry = b.nodes[0],
        object = b.objects.find((o: any) => o.hash === entry.objects['plugin-set.json'])
      const plugins = JSON.parse(Buffer.from(object.data, 'base64').toString())
      plugins.seams.memory[0].version = '999.0.0'
      replace(b, entry, 'plugin-set.json', Buffer.from(JSON.stringify(plugins)))
    },
    b => {
      b.version = 2
    },
    b => {
      b.objects.pop()
    },
    b => {
      b.objects[0].data = 'AAAA'
    },
    b => {
      b.objects.push(b.objects[0])
    },
    b => {
      b.nodes.push(b.nodes[0])
    },
    b => {
      b.nodes[0].node.parentNodeId = b.nodes[0].node.id
    },
    b => {
      b.tree.storylines[1].parentStorylineId = b.tree.storylines[1].id
    },
    b => {
      b.tree.storylines[1].parentNodeId = randomUUID()
    },
    b => {
      b.nodes[0].objects['../secret'] = b.objects[0].hash
    },
    b => {
      b.tree.packHash = 'sha256:' + '0'.repeat(64)
      for (const e of b.nodes) e.node.packHash = b.tree.packHash
    },
    b => {
      b.nodes[0].node.memoryProvider = 'unavailable-memory'
    },
    b => {
      const entries = f.branches.map(branch => b.nodes.find((e: any) => e.node.id === branch.node.id))
      const object = b.objects.find((o: any) => o.hash === entries[1].objects['core-memory.json'])
      replace(b, entries[0], 'core-memory.json', Buffer.from(object.data, 'base64'))
      b.objects = [...new Map(b.objects.map((o: any) => [o.hash, o])).values()]
    },
  ]
  const before = f.receiver.snapshot(),
    calls = f.calls()
  for (const mutate of cases) {
    const b = structuredClone(original)
    mutate(b)
    const path = join(f.root, '..', 'bad.perspectra-backup')
    writeFileSync(path, JSON.stringify(b))
    await expect(
      f.receiver.handle({ operation: 'tree-restore', packageId: f.packageId, path, name: '拒绝' }),
    ).rejects.toThrow()
    expect(f.receiver.snapshot()).toEqual(before)
    expect(
      existsSync(join(f.receiver.root, 'instances')) ? readdirSync(join(f.receiver.root, 'instances')) : [],
    ).toEqual([])
  }
  // Graph is legal, but this claimed ancestor is a different same-sequence history.
  const falseParent = structuredClone(original)
  const a = f.branches[0]!,
    b = f.branches[1]!
  const line = falseParent.tree.storylines.find((l: any) => l.id === b.id)
  line.parentStorylineId = a.id
  line.parentNodeId = a.node.id
  falseParent.nodes.find((e: any) => e.node.id === b.node.id).node.parentNodeId = a.node.id
  const forged = join(f.root, '..', 'false-ancestor.perspectra-backup')
  writeFileSync(forged, JSON.stringify(falseParent))
  await expect(
    f.receiver.handle({ operation: 'tree-restore', packageId: f.packageId, path: forged, name: '伪造祖先' }),
  ).rejects.toThrow('实际世界事实前缀不一致')
  expect(f.receiver.snapshot()).toEqual(before)
  expect(readdirSync(join(f.receiver.root, 'instances'))).toEqual([])
  expect(f.calls()).toEqual(calls)
  expect(files(f.root)).toEqual(f.before)
  await expect(
    f.source.handle({ operation: 'tree-backup', instanceId: f.instanceId, path: f.archive }),
  ).rejects.toThrow('已存在')
}, 120_000)

it('failed index publication and a killed restore never list a partial instance; retry is independent', async () => {
  const f = await setup(),
    index = join(f.receiver.root, 'launcher.json')
  renameSync(index, index + '.held')
  mkdirSync(index)
  await expect(
    f.receiver.handle({ operation: 'tree-restore', packageId: f.packageId, path: f.archive, name: '失败' }),
  ).rejects.toThrow()
  expect(f.receiver.snapshot().instances).toHaveLength(0)
  expect(readdirSync(join(f.receiver.root, 'instances'))).toEqual([])
  rmSync(index, { recursive: true })
  renameSync(index + '.held', index)
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { LauncherCore } from './apps/launcher/backend/core.ts';
    const core = new LauncherCore(process.cwd(), process.argv[1]);
    await core.initialize(); console.log('ready');
    await new Promise(resolve => process.stdin.once('data', resolve));
    await core.handle({operation:'tree-restore',packageId:process.argv[2],path:process.argv[3],name:'interrupted'});
    await core.close();
  `,
      f.receiver.root,
      f.packageId,
      f.archive,
    ],
    { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] },
  )
  cleanup.push(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  await once(child.stdout, 'data')
  const watcher = watch(join(f.receiver.root, 'instances'), (_event, file) => {
    if (file?.startsWith('.')) child.kill('SIGKILL')
  })
  try {
    const closed = once(child, 'close')
    child.stdin.write('restore\n')
    const [, signal] = await closed
    expect(signal).toBe('SIGKILL')
  } finally {
    watcher.close()
  }
  const reopened = new LauncherCore(resolve('.'), f.receiver.root)
  await reopened.initialize()
  cleanup.push(() => reopened.close())
  expect(reopened.snapshot().instances).toHaveLength(0)
  expect(readdirSync(join(f.receiver.root, 'instances')).every(name => name.startsWith('.'))).toBe(true)
  await reopened.handle({ operation: 'tree-restore', packageId: f.packageId, path: f.archive, name: '中断后重试' })
  expect(reopened.snapshot().instances).toHaveLength(1)
  expect(files(f.root)).toEqual(f.before)
}, 120_000)
