import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { restoreStoryNode } from '../../desktop/story-nodes.ts'
import { WorldHostRuntime, type WorldHostOptions } from '../../desktop/host/world-runtime.ts'
import { createRoleplayCore } from '../support/roleplay-runtime.ts'
import { LensSimulation } from '../../desktop/lens/simulation.ts'
import type { CoreRunner } from '../../packages/official-memory-core/src/python-worker.ts'
import { createRuntimeWithCore } from '../support/core-memory-options.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const COMPANION = 'character:companion',
  SEEN = '你看见门缝里那张催租单。'
const obj = (value: unknown) => value as WorldJsonObject

const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'pacing-branches-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  return root
}
function pack(beats: Record<string, string>, intensity = 'low', cooldown = 0): string {
  const packPath = join(fresh(), 'pack')
  cpSync(resolve('examples/world-packs/prototype-g1'), packPath, { recursive: true })
  mkdirSync(join(packPath, 'scripts'), { recursive: true })
  writeFileSync(join(packPath, 'scripts/status.js'), readFileSync(resolve('tests/fixtures/status-market.js'), 'utf8'))
  const definition = {
    cycleRounds: 16,
    chance: 1,
    cooldownRounds: { low: cooldown, medium: cooldown, high: cooldown },
    recoveryRounds: 0,
    beats: Object.fromEntries(Object.keys(beats).map(id => [id, { intensity }])),
  }
  writeFileSync(
    join(packPath, 'scripts/pacing.js'),
    `globalThis.pacingScript = { definition: ${JSON.stringify(definition)}, beats: { ${Object.entries(beats)
      .map(([id, body]) => `'${id}': { when: () => [['总是', true]], ${body} }`)
      .join(', ')} } }`,
  )
  const file = join(packPath, 'worldpack.source.json'),
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.assetFiles = ['scripts/status.js', 'scripts/pacing.js']
  writeFileSync(file, JSON.stringify(manifest))
  return packPath
}
async function open(packPath: string, extra: Partial<WorldHostOptions> & Record<string, unknown> = {}) {
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  cleanups.push(() => server.close())
  const root = (extra.dataDirectory as string | undefined) ?? fresh()
  const options = { packPath, dataDirectory: root, models: fakeModels(server.endpoint), timeoutMs: 5000, ...extra }
  const runtime = extra.memoryCore
    ? await createRuntimeWithCore(options as never)
    : await WorldHostRuntime.create(options as never)
  let closed = false
  const close = async () => {
    if (!closed) await runtime.close()
    closed = true
  }
  cleanups.push(close)
  const beats = () => {
    // A regenerated round lives in its own candidate directory.
    const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
    try {
      return store
        .readEvents(runtime.address)
        .filter(e => e.eventType === 'status.updated' && obj(obj(e.data).source).kind === 'beat')
        .map(e => ({ beatId: obj(obj(e.data).source).beatId, changes: obj(e.data).changes }))
    } finally {
      store.close()
    }
  }
  return { runtime, root, beats, close }
}
const decision = (runtime: { creatorInspection(): { pacing: unknown } }) => obj(runtime.creatorInspection().pacing)

const random = `apply: truth => ({
  changes: [{ holderId: null, key: 'time', value: truth.public.time + 1 + Math.floor(Math.random() * 100000) }] })`

it('brings the same beat with the same values when a round is regenerated', async () => {
  const f = await open(pack({ a: random, b: random, c: random }), { storyNodes: true })
  const state = await f.runtime.submit('你好。')
  const first = f.beats(),
    before = f.runtime.dataDirectory
  expect(first).toHaveLength(1)
  await f.runtime.regenerate(state.tailRound!.id!, 'pacing-regeneration')
  expect(f.runtime.dataDirectory).not.toBe(before)
  expect(f.beats()).toEqual(first)
})

it('keeps the cooldown and the phase across a restored node', async () => {
  const packPath = pack({ loud: `apply: () => ({})` }, 'high', 8)
  const f = await open(packPath, { storyNodes: true })
  await f.runtime.submit('你好。')
  expect(f.beats()).toHaveLength(1)
  const node = await f.runtime.saveNode('节奏节点')
  await f.close()
  const target = join(fresh(), 'restored')
  restoreStoryNode(f.root, node.id, target, node.packHash)
  const restored = await open(packPath, { dataDirectory: target })
  await restored.runtime.submit('还在吗？')
  expect(restored.beats()).toHaveLength(1)
  expect(decision(restored.runtime).reason).toMatchObject({ why: 'cooling', round: 2 })
})

it('lets two branches go their own way from one node', async () => {
  const packPath = pack({ first: `apply: () => ({})`, last: `apply: () => ({})` })
  const opened = async (dataDirectory: string, extra: Partial<WorldHostOptions> = {}) => {
    const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
    cleanups.push(() => server.close())
    const runtime = await createRoleplayCore({
      packPath,
      dataDirectory,
      models: fakeModels(server.endpoint),
      timeoutMs: 5000,
      ...extra,
    })
    return runtime
  }
  const root = fresh()
  const origin = await opened(root, { storyNodes: true })
  origin.beginRoundRandom([0, 0])
  await origin.submit('你好。')
  const node = await origin.saveNode('分支节点')
  await origin.close()
  const branch = async (draws: number[]) => {
    const target = join(fresh(), 'branch')
    restoreStoryNode(root, node.id, target, node.packHash)
    const runtime = await opened(target)
    cleanups.push(() => runtime.close())
    runtime.beginRoundRandom(draws)
    await runtime.submit('然后呢？')
    const store = new WorldStore(join(target, 'world.sqlite'))
    try {
      return store
        .readEvents(runtime.address)
        .filter(e => e.eventType === 'status.updated' && obj(obj(e.data).source).kind === 'beat')
        .map(e => obj(obj(e.data).source).beatId)
    } finally {
      store.close()
    }
  }
  expect(await branch([0, 0])).toEqual(['first', 'first'])
  expect(await branch([0, 0.99])).toEqual(['first', 'last'])
})

it('keeps memory sources consistent when a beat round is regenerated under Core memory', async () => {
  const memory: CoreRunner = async input =>
    input.operation === 'build'
      ? {
          archive: { scope: input.scope!, sources: input.sources!, facts: [], episodes: [], observations: [] },
          index: { scope: input.scope!, units: [], vectors: [] },
        }
      : { delivery: [], deliveryTrace: { delivered: [], activityCoverage: [] } }
  const f = await open(
    pack({
      rent: `apply: () => ({ stimuli: [{ characterId: '${COMPANION}', kind: 'perception', text: '${SEEN}' }] })`,
    }),
    { storyNodes: true, memoryCore: true, memoryCoreRun: memory, memoryCoreBuildRun: memory },
  )
  const rows = () => {
    const db = new DatabaseSync(join(f.runtime.dataDirectory, 'memory.sqlite'), { readOnly: true })
    try {
      return db
        .prepare('SELECT epistemic_kind FROM cognitive_memory_v2_sources WHERE text_value LIKE ?')
        .all(`%${SEEN}%`) as { epistemic_kind: string }[]
    } finally {
      db.close()
    }
  }
  const state = await f.runtime.submit('你好。')
  await f.runtime.regenerate(state.tailRound!.id!, 'pacing-core-regeneration')
  expect(f.beats()).toHaveLength(1)
  const sources = rows()
  expect(new Set(sources.map(row => row.epistemic_kind))).toEqual(new Set(['direct_observation']))
})

it('shows the creator the reason in a lens simulation, through the same composition', async () => {
  const simulation = await LensSimulation.open(pack({ rent: `apply: () => ({ notice: '门缝里塞进来一张纸。' })` }))
  cleanups.push(() => simulation.close())
  const trace = await simulation.step({ kind: 'say', text: '你好。' })
  expect(trace.pacing).toMatchObject({ kind: 'beat', key: 'rent', reason: { why: 'chosen' } })
  expect(trace.lines.some(line => line.text.includes('节拍 rent'))).toBe(true)
})
