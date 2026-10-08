import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import { PlaytestMemoryCore, DEFAULT_MEMORY_CONTEXT_BUDGET, MEMORY_DELIVERY_BUDGET, estimateContextTokens, type MemoryContextBudget } from '../experiments/playtest-memory-core.ts'
import { createPlaytestServer } from '../experiments/playtest-server.ts'
import { parsePlaytestLaunchArguments } from '../experiments/playtest-launch.ts'
import type { CoreRunner } from '../experiments/hindsight-python.ts'

const roots: string[] = [], runtimes: FrozenWorldPlaytestRuntime[] = [], servers: Server[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()))
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('memory-web-test-'))
      throw new Error('unexpected temporary directory')
    rmSync(root, { recursive: true, force: true })
  }
})
async function fixture(run: CoreRunner, options: { playSettings?: import('../../desktop/play-settings.ts').PlaySettings; memoryContextBudget?: MemoryContextBudget; publish?: boolean } = {}) {
  const data = mkdtempSync(join(tmpdir(), 'memory-web-test-')); roots.push(data)
  const requests: WorldJsonObject[] = []
  const provider = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += String(c) })
    req.on('end', () => {
      const wire = JSON.parse(body)
      requests.push(JSON.parse(wire.messages.at(-1).content))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(options.publish ? { decision: 'publish', addresseeIds: ['character:player'], segments: [{ type: 'speech', text: '我在听。' }] } : { decision: 'abstain' }) } }] }))
    })
  })
  servers.push(provider); provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('no port')
  const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: data,
    packPath: resolve('examples/world-packs/ai-girls-hosted-guess'), provider: 'local', model: 'fixture',
    utilityEndpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, memoryCore: true, memoryCoreRun: run, memoryCoreBuildRun: run, ...(options.playSettings?{playSettings:options.playSettings}:{}), ...(options.memoryContextBudget ? { memoryContextBudget: options.memoryContextBudget } : {}) })
  runtimes.push(runtime)
  const head = () => { const store = new WorldStore(join(data, 'world.sqlite'))
    try { return store.head(runtime.address).headSeq } finally { store.close() } }
  return { data, runtime, requests, head }
}
function built(input: WorldJsonObject): WorldJsonObject {
  return { archive: { scope: input.scope!, sources: input.sources!, facts: [], episodes: [], observations: [] },
    index: { scope: input.scope!, units: [], vectors: [] } }
}
const empty = { delivery: [], deliveryTrace: { delivered: [], activityCoverage: [] } }
const ref = (source: WorldJsonObject): WorldJsonObject => Object.fromEntries(
  ['sourceId','sourceHash','epistemicKind','worldSeq','characterId','worldAddress'].map(k => [k, source[k]!]))

describe('optional web Core memory', () => {
  it('parses the explicit switch and rejects a duplicate', () => {
    expect(parsePlaytestLaunchArguments(['--memory-core']).memoryCore).toBe(true)
    expect(parsePlaytestLaunchArguments([]).memoryCore).toBeUndefined()
    expect(() => parsePlaytestLaunchArguments(['--memory-core','--memory-core'])).toThrow('once')
  })
  it('refreshes authorized prefixes without world events; core requests omit private activity and variables', async () => {
    const inputs: WorldJsonObject[] = []
    const run: CoreRunner = async input => { inputs.push(input); return input.operation === 'build' ? built(input) : empty }
    const f = await fixture(run), before = f.head()
    const state = await f.runtime.refreshMemory(); await f.runtime.waitForMemory()
    expect(f.head()).toBe(before); expect(state.busy).toBe(false)
    expect(JSON.stringify(state)).not.toContain('sourceHash')
    expect(inputs.filter(i => i.operation === 'build')).toHaveLength(4)
    for (const input of inputs) for (const source of input.sources as WorldJsonObject[])
      expect(source.characterId).toBe((input.scope as WorldJsonObject).characterId)
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, run)
    await adapter.project({ context: { character: { characterId: 'character:claude', name: 'Claude' },
      scene: { people: [] }, stimulus: [], observations: [], selfObservations: [],
      activity: { private: 'private-answer' }, packVariables: { private: 'private-variable' } }, continuation: false }, AbortSignal.timeout(2000))
    const recall = inputs.at(-1)!
    expect(recall.operation).toBe('recall')
    expect(recall.deliveryMode).toBe('minimal')
    expect(JSON.stringify(recall.request)).not.toContain('private-answer')
    expect(JSON.stringify(recall.request)).not.toContain('private-variable')
    expect(Object.keys(recall)).not.toContain('worldPath')
    await f.runtime.submit('早上好，今天打算做些什么？')
    expect(f.requests.length).toBeGreaterThan(0)
    expect(f.requests.every(r => Array.isArray((r.context as WorldJsonObject).memories))).toBe(true)
    expect(f.requests.every(r => r.canRecall === false && r.recallEvidence === undefined)).toBe(true)
    // A restart reuses the same archives and restores only previously authorized identity entries.
    const restarted = new PlaytestMemoryCore(f.data, f.runtime.address, run)
    await restarted.refresh(['character:claude'], AbortSignal.timeout(2000), () => {})
    const refresh = inputs.at(-1)!
    expect(refresh.retainedPrefix).toBeDefined()
    expect(JSON.stringify(refresh.aliasHistory)).toContain('Claude')
  })
  it('rejects a cache from another character before asking Python', async () => {
    let calls = 0
    const run: CoreRunner = async input => { calls++; return built(input) }
    const f = await fixture(run); await f.runtime.refreshMemory(); await f.runtime.waitForMemory()
    const path = join(f.data, 'memory-core', Buffer.from('character:claude').toString('base64url') + '.json')
    const cached = JSON.parse(readFileSync(path, 'utf8'))
    cached.archive.scope.characterId = 'character:gpt'; cached.index.scope.characterId = 'character:gpt'
    writeFileSync(path, JSON.stringify(cached)); const before = calls
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, run)
    await expect(adapter.project({ context: { character: { characterId: 'character:claude' }, scene: { people: [] } },
      continuation: false }, AbortSignal.timeout(2000))).rejects.toThrow('another role')
    expect(calls).toBe(before)
  })
  it('rejects delivery references from another role even when the source ID exists', async () => {
    const run: CoreRunner = async input => {
      if (input.operation === 'build') return built(input)
      const source = ((input.archive as WorldJsonObject).sources as WorldJsonObject[])[0]!
      return { delivery: [{ text: 'wrong', sourceIds: [source.sourceId!] }], deliveryTrace: {
        delivered: [{ sourceRefs: [{ ...ref(source), characterId: 'character:gpt' }] }] } }
    }
    const f = await fixture(run); await f.runtime.refreshMemory(); await f.runtime.waitForMemory()
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, run)
    await expect(adapter.project({ context: { character: { characterId: 'character:claude' }, scene: { people: [] } },
      continuation: false }, AbortSignal.timeout(2000))).rejects.toThrow('authorized evidence')
  })
  it('delivers speech-supported cognition with partial evidence and rejects foreign excerpts', async () => {
    let foreign = false
    const run: CoreRunner = async input => {
      if (input.operation === 'build') return built(input)
      const source = ((input.archive as WorldJsonObject).sources as WorldJsonObject[])[0]!
      return { delivery: [{ memoryId: 'cognition:example', memoryLevel: 'observation',
        text: '【本角色的可修正认识】两处说法有分歧。', sourceIds: [source.sourceId!],
        sourceTypes: ['reported_speech'], hasUnresolvedCounterEvidence: true,
        evidenceCoverage: { complete: false, included: 0, total: 2 },
        keyEvidence: foreign ? [{ sourceId: 'event:foreign', text: 'private' }] : [] }],
        deliveryTrace: { delivered: [{ sourceRefs: [ref(source)] }] } }
    }
    const f = await fixture(run); await f.runtime.refreshMemory(); await f.runtime.waitForMemory()
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, run)
    const request = { context: { character: { characterId: 'character:claude' }, scene: { people: [] } }, continuation: false }
    const projected = await adapter.project(request, AbortSignal.timeout(2000))
    expect((projected.context.memories as WorldJsonObject[])[0]!.hasUnresolvedCounterEvidence).toBe(true)
    foreign = true
    await expect(adapter.project(request, AbortSignal.timeout(2000))).rejects.toThrow('excerpt source is unauthorized')
  })
  it('accepts the widened delivery and still rejects exceeding its host budget', async () => {
    let count = 6
    const run: CoreRunner = async input => {
      if (input.operation === 'build') return built(input)
      const source = ((input.archive as WorldJsonObject).sources as WorldJsonObject[])[0]!
      return { delivery: Array.from({ length: count }, (_v, i) => ({ text: `证据 ${i}`, sourceIds: [source.sourceId!] })),
        deliveryTrace: { delivered: [{ sourceRefs: [ref(source)] }] } }
    }
    const f = await fixture(run); await f.runtime.refreshMemory(); await f.runtime.waitForMemory()
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, run)
    const request = { context: { character: { characterId: 'character:claude' }, scene: { people: [] } }, continuation: false }
    expect((await adapter.project(request, AbortSignal.timeout(2000))).context.memories).toHaveLength(6)
    count = 7
    await expect(adapter.project(request, AbortSignal.timeout(2000))).rejects.toThrow('budget exceeded')
  })
  it('background maintenance stays separate from playing and can be explicitly cancelled', async () => {
    let entered!: () => void
    const started = new Promise<void>(done => { entered = done })
    const run: CoreRunner = async (input, signal) => {
      if (input.operation === 'recall') return empty
      return new Promise((_resolve, reject) => {
        entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const f = await fixture(run), before = f.head()
    const state = await f.runtime.refreshMemory()
    await started
    expect(state.busy).toBe(false)
    expect((await f.runtime.state()).memoryMaintenance!.running).toBe(2)
    await f.runtime.submit('整理期间的新经历，只在这个房间里说。')
    expect(f.head()).toBeGreaterThan(before)
    expect((await f.runtime.state()).busy).toBe(false)
    await f.runtime.cancelMemory(); await f.runtime.waitForMemory()
    expect((await f.runtime.state()).memoryMaintenance!.cancelled).toBe(4)
    expect((await f.runtime.state()).error).toBe(false)
  })
  it('closing a game cancels unfinished builds without installing transient results', async () => {
    const run: CoreRunner = async (input, signal) => input.operation === 'recall' ? empty :
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    const f = await fixture(run), before = f.head()
    await f.runtime.refreshMemory(); await f.runtime.close()
    expect((await f.runtime.state()).memoryMaintenance!.cancelled).toBe(4)
    expect(f.head()).toBe(before)
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, run)
    expect(adapter.archivePrefix('character:claude')).toBe(0)
  })
  it('keeps declared activity interaction usable while background builds are pending', async () => {
    const run: CoreRunner = async (input, signal) => input.operation === 'recall' ? empty :
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    const f = await fixture(run), before = f.head()
    await f.runtime.refreshMemory()
    const state = await f.runtime.state()
    const result = await f.runtime.activityAction({ activityId: state.activity!.id as string | null,
      revision: Number(state.activity!.revision), operation: 'start', parameters: {}, requestId: 'background-start' })
    expect(f.head()).toBeGreaterThan(before)
    expect((result.activity!.game as WorldJsonObject).active).toBe(true)
    expect(result.memoryMaintenance!.running).toBe(2)
    expect(result.busy).toBe(false)
    await f.runtime.cancelMemory(); await f.runtime.waitForMemory()
  })
  it('reports a failed role snapshot and still starts other independent builds', async () => {
    const f = await fixture(async input => input.operation === 'recall' ? empty : built(input))
    const path = join(f.data, 'memory-core', Buffer.from('character:claude').toString('base64url') + '.json')
    writeFileSync(path, '{broken')
    await f.runtime.refreshMemory(); await f.runtime.waitForMemory()
    const state = await f.runtime.state()
    expect(state.memoryMaintenance!.completed).toBe(3)
    expect(state.memoryMaintenance!.failed).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, async () => empty)
    await expect(adapter.project({ context: { character: { characterId: 'character:claude' } }, continuation: false },
      AbortSignal.timeout(2000))).rejects.toThrow()
  })
  it('HTTP maintenance is authenticated and exposes no source archive in its response', async () => {
    let builds = 0
    const f = await fixture(async input => { if (input.operation === 'build') builds++; return built(input) })
    const server = createPlaytestServer(f.runtime, 'a'.repeat(64)); servers.push(server)
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    const url = `http://127.0.0.1:${address.port}/api/memory/refresh`
    expect((await fetch(url, { method: 'POST' })).status).toBe(401); expect(builds).toBe(0)
    expect((await fetch(url.replace('refresh', 'cancel'), { method: 'POST' })).status).toBe(401)
    const response = await fetch(url, { method: 'POST', headers: { 'x-playtest-token': 'a'.repeat(64) } })
    expect(response.status).toBe(200); await f.runtime.waitForMemory(); expect(builds).toBe(4)
    expect(await response.text()).not.toContain('sourceHash')
  })
  it('keeps more than eight rounds of observations and self expressions without maintenance', async () => {
    let builds = 0
    const f = await fixture(async input => { builds++; return built(input) }, { publish: true })
    for (let i = 0; i < 12; i++) await f.runtime.submit(i === 0 ? '记住私下的安排：银杏电台。' : `继续闲聊第 ${i} 次。`)
    const requests = f.requests.filter(r => ((r.context as WorldJsonObject).character as WorldJsonObject).characterId === 'character:claude')
    const context = requests.at(-1)!.context as WorldJsonObject
    expect((context.observations as WorldJsonObject[]).length).toBeGreaterThan(16)
    expect((context.selfObservations as WorldJsonObject[]).length).toBeGreaterThan(8)
    expect(JSON.stringify(context.observations)).toContain('银杏电台')
    expect(builds).toBe(0)
  })
  it('queues at the estimated token threshold, archives a complete early prefix and keeps its newer tail', async () => {
    const inputs: WorldJsonObject[] = []
    const run: CoreRunner = async input => { inputs.push(input); return input.operation === 'build' ? built(input) : empty }
    const f = await fixture(run, { publish: true, memoryContextBudget: { triggerTokens: 200_000, compactTokens: 150_000, minimumRecentTokens: 0 } })
    await f.runtime.submit('第一条。'); await f.runtime.submit('第二条。')
    const request = f.requests.findLast(r => ((r.context as WorldJsonObject).character as WorldJsonObject).characterId === 'character:claude')!
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, run, { triggerTokens: 200_000, compactTokens: 150_000, minimumRecentTokens: 0 })
    expect(DEFAULT_MEMORY_CONTEXT_BUDGET.triggerTokens).toBe(170_000)
    // Two complete event groups approximate a 150k older prefix and a 50k newer tail.
    const seqs = (request.context as WorldJsonObject).observations as WorldJsonObject[]
    const earlier = Number(seqs[0]!.sourceSeq), later = Number(seqs.at(-1)!.sourceSeq)
    const input = { context: { ...(request.context as WorldJsonObject), observations: [
      { sourceSeq: earlier, text: '旧'.repeat(149_800) }, { sourceSeq: later, text: '新'.repeat(50_000) }], selfObservations: [] }, continuation: false }
    adapter.observeContext(input, 'x'.repeat(3 * (200_000 - 513)))
    expect(adapter.hasPendingCompaction).toBe(false)
    adapter.observeContext(input, 'x'.repeat(3 * (200_000 - 512)))
    expect(adapter.hasPendingCompaction).toBe(true)
    expect(adapter.archivePrefix('character:claude')).toBe(0)
    const before = f.head()
    await adapter.compactPending(AbortSignal.timeout(2000), () => {})
    expect(f.head()).toBe(before)
    expect(adapter.archivePrefix('character:claude')).toBe(earlier)
    expect(adapter.hasPendingCompaction).toBe(false)
    const build = inputs.at(-1)!
    expect((build.scope as WorldJsonObject).asOfWorldSeq).toBe(earlier)
    expect((build.sources as WorldJsonObject[]).every(source => Number(source.worldSeq) <= earlier)).toBe(true)
    await f.runtime.submit('继续。')
    const tail = (f.requests.findLast(r => ((r.context as WorldJsonObject).character as WorldJsonObject).characterId === 'character:claude')!.context as WorldJsonObject).observations as WorldJsonObject[]
    expect(tail.every(record => Number(record.sourceSeq) > earlier)).toBe(true)
    expect(tail.some(record => Number(record.sourceSeq) === later)).toBe(true)
    const recall = inputs.find(i => i.operation === 'recall')!
    expect(recall.deliveryBudget).toEqual(MEMORY_DELIVERY_BUDGET)
    expect(estimateContextTokens('中文abc')).toBe(3)
  })
  it('does not advance the short-term boundary on failed, cancelled or incomplete builds', async () => {
    let mode: 'fail' | 'cancel' | 'incomplete' | 'ok' = 'fail'
    const controller = new AbortController()
    const run: CoreRunner = async input => {
      if (mode === 'fail') throw new Error('fixture failure')
      if (mode === 'cancel') controller.abort()
      if (mode === 'incomplete') return built({ ...input, scope: { ...(input.scope as WorldJsonObject), asOfWorldSeq: 0 }, sources: [] })
      return built(input)
    }
    const f = await fixture(run)
    await f.runtime.submit('第一条。'); await f.runtime.submit('第二条。')
    const request = f.requests.at(-1)!
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, run, { triggerTokens: 1000, compactTokens: 100 })
    adapter.observeContext({ context: request.context as WorldJsonObject, continuation: false }, '旧'.repeat(1000))
    expect(adapter.hasPendingCompaction).toBe(true)
    await expect(adapter.compactPending(AbortSignal.timeout(2000), () => {})).rejects.toThrow('fixture failure')
    adapter.observeContext({ context: request.context as WorldJsonObject, continuation: false }, '旧'.repeat(1000))
    mode = 'incomplete'
    await expect(adapter.compactPending(AbortSignal.timeout(2000), () => {})).rejects.toThrow('requested prefix')
    adapter.observeContext({ context: request.context as WorldJsonObject, continuation: false }, '旧'.repeat(1000))
    mode = 'cancel'
    await expect(adapter.compactPending(controller.signal, () => {})).rejects.toThrow()
    expect(adapter.archivePrefix(String(((request.context as WorldJsonObject).character as WorldJsonObject).characterId))).toBe(0)
    expect(adapter.hasPendingCompaction).toBe(false)
    adapter.observeContext({ context: request.context as WorldJsonObject, continuation: false }, '旧'.repeat(1000))
    mode = 'ok'
    await adapter.compactPending(AbortSignal.timeout(2000), () => {})
    expect(adapter.archivePrefix(String(((request.context as WorldJsonObject).character as WorldJsonObject).characterId))).toBeGreaterThan(0)
  })
  it('automatic compaction is detached from the turn and leaves the game usable', async () => {
    let entered!: () => void
    const started = new Promise<void>(done => { entered = done })
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    let buildInput: WorldJsonObject | undefined
    const run: CoreRunner = async (input, signal) => {
      if (input.operation === 'recall') return empty
      buildInput = input; entered()
      await Promise.race([gate, new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])
      return built(input)
    }
    const f = await fixture(run, { memoryContextBudget: { triggerTokens: 1000, compactTokens: 100 }, publish: true })
    await f.runtime.submit('你们简单回应一句就好。'); await started
    expect((await f.runtime.state()).busy).toBe(false)
    expect(Number((buildInput!.scope as WorldJsonObject).asOfWorldSeq)).toBeLessThan(f.head())
    const before = f.head()
    await f.runtime.submit('后台整理时我仍然能说话。')
    expect(f.head()).toBeGreaterThan(before)
    await f.runtime.cancelMemory(); release(); await f.runtime.waitForMemory()
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, run)
    expect(adapter.archivePrefix(String((buildInput!.scope as WorldJsonObject).characterId))).toBe(0)
  })
  it('freezes queued roles immediately, installs independent successes and keeps post-freeze events raw', async () => {
    const inputs: WorldJsonObject[] = []
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    let active = 0, peak = 0
    const run: CoreRunner = async input => {
      if (input.operation === 'recall') return empty
      inputs.push(input); active++; peak = Math.max(peak, active)
      try {
        await gate
        if ((input.scope as WorldJsonObject).characterId === 'character:glm') throw Error('fixture build failed')
        return built(input)
      } finally { active-- }
    }
    const f = await fixture(run, { publish: true })
    const frozen = f.head()
    await f.runtime.refreshMemory()
    await vi.waitFor(() => expect(inputs).toHaveLength(2))
    await f.runtime.submit('冻结之后的新暗号：紫杉七号。')
    const liveHead = f.head()
    expect(liveHead).toBeGreaterThan(frozen)
    release(); await f.runtime.waitForMemory()
    expect(inputs).toHaveLength(4); expect(peak).toBe(2)
    for (const input of inputs) {
      expect((input.scope as WorldJsonObject).asOfWorldSeq).toBe(frozen)
      expect(JSON.stringify(input)).not.toContain('紫杉七号')
      expect((input.sources as WorldJsonObject[]).every(s => s.characterId === (input.scope as WorldJsonObject).characterId && Number(s.worldSeq) <= frozen)).toBe(true)
    }
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, run)
    expect(adapter.archivePrefix('character:claude')).toBe(frozen)
    expect(adapter.archivePrefix('character:glm')).toBe(0)
    expect((await f.runtime.state()).memoryMaintenance!.failed).toBe(1)
    expect((await f.runtime.state()).error).toBe(false)
    await f.runtime.submit('我们继续，刚才的新暗号还记得吗？')
    const context = f.requests.findLast(r => ((r.context as WorldJsonObject).character as WorldJsonObject).characterId === 'character:claude')!.context as WorldJsonObject
    expect(JSON.stringify(context.observations)).toContain('紫杉七号')
  })
  it('discards an older late result rather than replacing a newer archive', async () => {
    const gates = new Map<number, () => void>()
    const f = await fixture(async input => input.operation === 'recall' ? empty : built(input))
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, async input => {
      const prefix = Number((input.scope as WorldJsonObject).asOfWorldSeq)
      await new Promise<void>(done => { gates.set(prefix, done) })
      return built(input)
    })
    const older = f.head(); adapter.startRefresh(['character:claude'])
    await f.runtime.submit('这是更晚的一条。')
    const newer = f.head(); adapter.startRefresh(['character:claude'])
    await vi.waitFor(() => expect(gates.size).toBe(2))
    gates.get(newer)!()
    await vi.waitFor(() => expect(adapter.archivePrefix('character:claude')).toBe(newer))
    gates.get(older)!(); await adapter.waitForBackground()
    expect(adapter.archivePrefix('character:claude')).toBe(newer)
    expect(adapter.backgroundState().discarded).toBe(1)
    await adapter.close()
  })
  it('archive advancement during foreground recall does not invalidate that authorized turn', async () => {
    const f = await fixture(async input => input.operation === 'recall' ? empty : built(input), { publish: true })
    await f.runtime.refreshMemory(); await f.runtime.waitForMemory()
    await f.runtime.submit('旧档案之后的内容。')
    const context = f.requests.at(-1)!.context as WorldJsonObject
    const request = { context, continuation: false }
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, async input => input.operation === 'recall' ? empty : built(input),
      { triggerTokens: 1000, compactTokens: 100 })
    // The already prepared foreground context predates this successful install.
    await adapter.refresh([String((context.character as WorldJsonObject).characterId)], AbortSignal.timeout(2000), () => {})
    expect(() => adapter.observeContext(request, 'x'.repeat(10_000))).not.toThrow()
    expect(adapter.hasPendingCompaction).toBe(false)
  })

})

it('delivers the configured recall budget to Core while preserving authorized evidence checks',async()=>{
 const {playSettings}=await import('../../desktop/play-settings.ts')
 const inputs:WorldJsonObject[]=[]
 const run:CoreRunner=async input=>{inputs.push(input);return input.operation==='build'?built(input):empty}
 const f=await fixture(run,{playSettings:playSettings({memoryMaxItems:2,memoryMaxJsonChars:3000})})
 await f.runtime.submit('你好。')
 await f.runtime.refreshMemory();await f.runtime.waitForMemory()
 await f.runtime.submit('继续。')
 expect(inputs.filter(input=>input.operation==='recall').length).toBeGreaterThan(0)
 for(const input of inputs.filter(input=>input.operation==='recall'))expect(input.deliveryBudget).toEqual({maxItems:2,maxJsonChars:3000})
})
