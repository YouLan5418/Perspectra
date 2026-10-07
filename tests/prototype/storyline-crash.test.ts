import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { LauncherCore } from '../../desktop/launcher-core.ts'
import { readStoryNodes } from '../../desktop/story-nodes.ts'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import type { CoreRunner } from '../experiments/hindsight-python.ts'

const roots: string[] = [], children = new Set<ChildProcess>()
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(done => child.once('exit', () => done()))
  if (process.platform === 'win32') {
    const taskkill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    await new Promise<void>((done, reject) => {
      taskkill.once('error', reject)
      taskkill.once('exit', code => code === 0 ? done() : reject(new Error('taskkill failed: ' + code)))
    })
  } else child.kill('SIGKILL')
  await exited
  children.delete(child)
}
afterEach(async () => {
  for (const child of children) await kill(child)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function integrity(directory: string) {
  for (const name of ['world.sqlite', 'session.sqlite', 'memory.sqlite', 'context.sqlite']) {
    const path = join(directory, name)
    if (!existsSync(path)) continue
    const db = new DatabaseSync(path, { readOnly: true })
    try { expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' }) } finally { db.close() }
  }
}
const builds: WorldJsonObject[] = []
const run: CoreRunner = async input => {
  if (input.operation !== 'build') return { delivery: [], deliveryTrace: { delivered: [], activityCoverage: [] } }
  builds.push(input)
  return { archive: { scope: input.scope!, sources: input.sources!, facts: [], episodes: [], observations: [] },
    index: { scope: input.scope!, units: [], vectors: [] } }
}
async function fixture() {
  builds.length = 0
  const temporary = mkdtempSync(join(tmpdir(), 'story-kill-')); roots.push(temporary)
  const pack = join(temporary, 'pack'), root = join(temporary, 'launcher')
  cpSync(resolve('examples/world-packs/prototype-g1'), pack, { recursive: true })
  mkdirSync(join(pack, 'scripts'))
  cpSync(resolve('examples/world-packs/ai-girls-awaken-v10/scripts/variables.js'), join(pack, 'scripts/variables.js'))
  const source = JSON.parse(readFileSync(join(pack, 'worldpack.source.json'), 'utf8'))
  source.assetFiles = ['scripts/variables.js']
  writeFileSync(join(pack, 'worldpack.source.json'), JSON.stringify(source))
  const core = new LauncherCore(resolve('.'), root)
  await core.initialize(); await core.handle({ operation: 'load', path: pack })
  await core.handle({ operation: 'create', packageId: core.snapshot().packs[0]!.id, name: '崩溃测试实例' })
  const instanceId = core.snapshot().instances[0]!.id, directory = join(root, 'instances', instanceId)
  const options = { packPath: pack, provider: 'local' as const, model: 'fixture', memoryCore: true,
    memoryCoreRun: run, memoryCoreBuildRun: run }
  const create = (dataDirectory = directory) => FrozenWorldPlaytestRuntime.create({ ...options, dataDirectory })
  const runtime = await create()
  let node
  try {
    await runtime.submit('/vars [{"op":"replace","path":"/public/剧情/阶段","value":"节点阶段"}]')
    node = await runtime.saveNode('安全起点')
    await runtime.submit('/vars [{"op":"replace","path":"/public/剧情/阶段","value":"原线未来"}]')
    await runtime.refreshMemory(); await runtime.waitForMemory()
    expect(readdirSync(join(directory, 'memory-core')).filter(name => name.endsWith('.json'))).toHaveLength(2)
  } finally { await runtime.close() }
  const original = () => {
    integrity(directory)
    const store = new WorldStore(join(directory, 'world.sqlite'))
    try { return { events: store.readEvents(runtime.address), variables: readFileSync(join(directory, 'pack-variables.json'), 'utf8'),
      cognition: Object.fromEntries(readdirSync(join(directory, 'memory-core')).filter(name => name.endsWith('.json'))
        .map(name => [name, readFileSync(join(directory, 'memory-core', name), 'utf8')])) } } finally { store.close() }
  }
  const before = original()
  async function reload() { const next = new LauncherCore(resolve('.'), root); await next.initialize(); return next }
  return { root, pack, directory, instanceId, nodeId: node!.id, node: node!, core, create, original, before, reload }
}
async function crash(config: { phase: string; root: string; pack: string; directory: string; instanceId: string; nodeId: string; lineId?: string }) {
  const { phase, root, pack, directory, instanceId, nodeId, lineId } = config
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/experiments/storyline-crash-worker.ts',
    JSON.stringify({ phase, root, pack, directory, instanceId, nodeId, lineId })],
    { cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let output = '', errors = ''
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => finish(new Error('fault point timeout: ' + output + errors)), 20_000)
    const finish = (error?: Error) => { clearTimeout(timer); child.off('exit', exited); child.off('error', failed); if (error) reject(error); else done() }
    const exited = () => finish(new Error('worker exited before fault point: ' + errors))
    const failed = (error: Error) => finish(error)
    child.once('exit', exited); child.once('error', failed)
    child.stderr!.on('data', chunk => { errors += String(chunk) })
    child.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('CRASH_POINT ') && output.endsWith('\n')) finish() })
  })
  expect(child.exitCode).toBeNull() // Kill the actual paused process; do not simulate an exception.
  await kill(child)
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
}
for (const phase of ['save-unpublished', 'save-published']) {
  it('survives forced termination at ' + phase, async () => {
    const f = await fixture()
    await crash({ ...f, phase })
    expect(f.original()).toEqual(f.before)
    const nodes = readStoryNodes(f.directory)
    expect(nodes).toHaveLength(phase === 'save-published' ? 2 : 1)
    for (const node of nodes) integrity(join(f.directory, 'story-nodes', node.id))
    const core = await f.reload()
    expect(core.snapshot().instances[0]!.currentStorylineId).toBe('main')
    const runtime = await f.create()
    try { await runtime.saveNode('重启后正常保存') } finally { await runtime.close() }
    expect(f.original()).toEqual(f.before)
  }, 30_000)
}
for (const phase of ['fork-copy', 'fork-index-before']) {
  it('leaves an interrupted fork unindexed and permits a clean retry at ' + phase, async () => {
    const f = await fixture()
    await crash({ ...f, phase })
    expect(f.original()).toEqual(f.before)
    const core = await f.reload(), instance = core.snapshot().instances[0]!
    expect(instance.currentStorylineId).toBe('main'); expect(instance.storylines).toHaveLength(1)
    const abandoned = readdirSync(join(f.directory, 'storylines'))
    expect(abandoned).toHaveLength(1)
    if (phase === 'fork-copy') expect(existsSync(join(f.directory, 'storylines', abandoned[0]!, 'rebuild-memory.json'))).toBe(false)
    await core.handle({ operation: 'story-fork', instanceId: f.instanceId, nodeId: f.nodeId, name: '重新分叉' })
    const lineId = core.snapshot().instances[0]!.currentStorylineId
    expect(abandoned).not.toContain(lineId)
    const runtime = await f.create(join(f.directory, 'storylines', lineId))
    try { expect((await runtime.state()).packVariables?.public).toEqual({ 剧情: { 阶段: '节点阶段' } }) } finally { await runtime.close() }
    expect(f.original()).toEqual(f.before)
  }, 30_000)
}
for (const phase of ['switch-index-before', 'switch-index-after']) {
  it('restarts with one complete selection at ' + phase, async () => {
    const f = await fixture()
    await f.core.handle({ operation: 'story-fork', instanceId: f.instanceId, nodeId: f.nodeId, name: '切换目标' })
    const lineId = f.core.snapshot().instances[0]!.currentStorylineId
    await f.core.handle({ operation: 'story-select', instanceId: f.instanceId, storylineId: 'main' })
    await crash({ ...f, phase, lineId })
    const core = await f.reload()
    expect(core.snapshot().instances[0]!.currentStorylineId).toBe(phase === 'switch-index-after' ? lineId : 'main')
    const child = await f.create(join(f.directory, 'storylines', lineId)); await child.close()
    await core.handle({ operation: 'story-select', instanceId: f.instanceId, storylineId: 'main' })
    const original = await f.create(); await original.close()
    expect(f.original()).toEqual(f.before)
  }, 30_000)
}
for (const phase of ['memory-temporary', 'memory-one-role']) {
  it('keeps the rebuild gate and reuses only complete role archives after ' + phase, async () => {
    const f = await fixture()
    await f.core.handle({ operation: 'story-fork', instanceId: f.instanceId, nodeId: f.nodeId, name: '记忆重建' })
    const lineId = f.core.snapshot().instances[0]!.currentStorylineId, directory = join(f.directory, 'storylines', lineId)
    await crash({ ...f, phase, directory, lineId })
    expect(f.original()).toEqual(f.before)
    expect(existsSync(join(directory, 'rebuild-memory.json'))).toBe(true)
    integrity(directory)
    const db = new DatabaseSync(join(directory, 'world.sqlite'), { readOnly: true })
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM writer_leases').get()).toEqual({ count: 0 }) } finally { db.close() }
    const archives = readdirSync(join(directory, 'memory-core')).filter(name => name.endsWith('.json'))
    expect(archives).toHaveLength(phase === 'memory-one-role' ? 1 : 0)
    const core = await f.reload()
    expect(core.snapshot().instances[0]!.currentStorylineId).toBe(lineId)
    // The player can return to the untouched original even while the child needs rebuilding.
    await core.handle({ operation: 'story-select', instanceId: f.instanceId, storylineId: 'main' })
    const original = await f.create(); await original.close()
    builds.length = 0
    const child = await f.create(directory)
    try {
      expect(existsSync(join(directory, 'rebuild-memory.json'))).toBe(false)
      expect(builds).toHaveLength(phase === 'memory-one-role' ? 1 : 2)
      const store = new WorldStore(join(directory, 'world.sqlite'))
      try { expect(store.readEvents(child.address)).toEqual(f.before.events.filter(event => event.seq <= f.node.headSeq)) } finally { store.close() }
      expect((await child.state()).packVariables?.public).toEqual({ 剧情: { 阶段: '节点阶段' } })
      await child.saveNode('重建后可保存')
    } finally { await child.close() }
    expect(f.original()).toEqual(f.before)
  }, 30_000)
}
