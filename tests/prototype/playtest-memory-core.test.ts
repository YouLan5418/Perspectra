import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import { PlaytestMemoryCore } from '../experiments/playtest-memory-core.ts'
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
async function fixture(run: CoreRunner) {
  const data = mkdtempSync(join(tmpdir(), 'memory-web-test-')); roots.push(data)
  const requests: WorldJsonObject[] = []
  const provider = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += String(c) })
    req.on('end', () => {
      const wire = JSON.parse(body)
      requests.push(JSON.parse(wire.messages.at(-1).content))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: 'abstain' }) } }] }))
    })
  })
  servers.push(provider); provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('no port')
  const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: data,
    packPath: resolve('examples/world-packs/ai-girls-hosted-guess'), provider: 'local', model: 'fixture',
    utilityEndpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, memoryCore: true, memoryCoreRun: run })
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
    const state = await f.runtime.refreshMemory()
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
    expect(JSON.stringify(recall.request)).not.toContain('private-answer')
    expect(JSON.stringify(recall.request)).not.toContain('private-variable')
    expect(Object.keys(recall)).not.toContain('worldPath')
    await f.runtime.submit('早上好，今天打算做些什么？')
    expect(f.requests.length).toBeGreaterThan(0)
    expect(f.requests.every(r => Array.isArray((r.context as WorldJsonObject).memories))).toBe(true)
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
    const f = await fixture(run); await f.runtime.refreshMemory()
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
    const f = await fixture(run); await f.runtime.refreshMemory()
    const adapter = new PlaytestMemoryCore(f.data, f.runtime.address, run)
    await expect(adapter.project({ context: { character: { characterId: 'character:claude' }, scene: { people: [] } },
      continuation: false }, AbortSignal.timeout(2000))).rejects.toThrow('authorized evidence')
  })
  it('escape cancels maintenance, preserves world prefix and restores usable speech', async () => {
    let entered!: () => void
    const started = new Promise<void>(done => { entered = done })
    const run: CoreRunner = async (_input, signal) => new Promise((_resolve, reject) => {
      entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const f = await fixture(run), before = f.head()
    const failure = f.runtime.refreshMemory().catch(error => error)
    await started; expect((await f.runtime.state()).busy).toBe(true)
    await f.runtime.escape(); await failure
    const state = await f.runtime.state()
    expect(state.busy).toBe(false); expect(state.error).toBe(false); expect(f.head()).toBe(before)
    expect((await f.runtime.submit('整理取消了，我们接着聊。')).busy).toBe(false)
  })
  it('HTTP maintenance is authenticated and exposes no source archive in its response', async () => {
    let builds = 0
    const f = await fixture(async input => { if (input.operation === 'build') builds++; return built(input) })
    const server = createPlaytestServer(f.runtime, 'a'.repeat(64)); servers.push(server)
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    const url = `http://127.0.0.1:${address.port}/api/memory/refresh`
    expect((await fetch(url, { method: 'POST' })).status).toBe(401); expect(builds).toBe(0)
    const response = await fetch(url, { method: 'POST', headers: { 'x-playtest-token': 'a'.repeat(64) } })
    expect(response.status).toBe(200); expect(builds).toBe(4)
    expect(await response.text()).not.toContain('sourceHash')
  })
})
