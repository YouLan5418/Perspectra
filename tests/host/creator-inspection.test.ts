import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { WorldHostCore } from '../../desktop/host/world-runtime.ts'
import { createHostServer } from '../../desktop/host/http-server.ts'
import { creatorInspectionQuery } from '../../desktop/host/creator-inspection.ts'
import { RequestInspector } from '../../packages/provider-chat/src/request-inspector.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function fixture(utilityEndpoint?: string) {
  const root = mkdtempSync(join(tmpdir(), 'perspectra-creator-debug-'))
  cleanups.push(async () => {
    rmSync(root, { recursive: true, force: true })
  })
  const runtime = await WorldHostCore.create({
    packPath: resolve('examples/world-packs/prototype-g1'),
    dataDirectory: root,
    provider: 'local',
    model: 'test',
    ...(utilityEndpoint ? { utilityEndpoint } : {}),
  })
  cleanups.push(() => runtime.close())
  return runtime
}
it('reports committed custody and movement, actual request context and observation recipients', async () => {
  const provider = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: 'abstain' }) } }] }))
    })
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  cleanups.push(async () => {
    provider.closeAllConnections()
    await new Promise<void>(done => provider.close(() => done()))
  })
  const runtime = await fixture('http://127.0.0.1:' + (provider.address() as AddressInfo).port + '/v1/chat/completions')
  runtime.requestInspection(true)
  const state = await runtime.state()
  const take = state
    .availableActions!.flatMap(action => action.interactions ?? [])
    .find(option => (option.definitionRef as { id: string }).id === 'base:take')!
  await runtime.perform({
    actionType: 'interact',
    parameters: {
      targetRef: take.targetRef!,
      definitionRef: take.definitionRef!,
      bindingId: take.bindingId!,
      arguments: take.arguments ?? {},
    },
  })
  const taken = runtime.creatorInspection(),
    id = (take.targetRef as { id: string }).id
  const item = taken.entities.find(entity => entity.id === id)!
  expect(item.state.holderId).toBe('character:player')
  expect(item.locationBasis).toBe('holder')
  const move = (await runtime.state()).availableActions!.find(action => action.actionType === 'move')!.destinations![0]!
  await runtime.perform({ actionType: 'move', parameters: { locationId: move.locationId } })
  const moved = runtime.creatorInspection({ afterSeq: taken.headSeq, limit: 100 })
  expect(moved.characters.find(character => character.id === 'character:player')?.locationId).toBe(move.locationId)
  expect(moved.entities.find(entity => entity.id === id)?.effectiveLocationId).toBe(move.locationId)
  expect(moved.events.items.some(event => event.eventType === 'observation.upsert')).toBe(true)
  const actor = taken.characters.find(
    character => character.id !== 'character:player' && character.processing.transport === 'ok',
  )!
  expect(actor).toBeDefined()
  const detail = runtime.creatorInspection({ characterId: actor.id })
  expect(detail.character?.latestRequest?.contextParts.some(part => part.name === 'history')).toBe(true)
})
it('reads the committed world and character view without calling a model or advancing the world', async () => {
  const runtime = await fixture(),
    before = await runtime.state()
  const snapshot = runtime.creatorInspection()
  expect(snapshot.characters.length).toBeGreaterThan(1)
  expect(snapshot.entities.length).toBeGreaterThan(0)
  expect(snapshot.entities.every(entity => entity.holderMeaning === 'custody')).toBe(true)
  const id = snapshot.characters[1]!.id
  const detail = runtime.creatorInspection({ characterId: id, afterSeq: 0, limit: 2 })
  expect(detail.character?.currentView.characterId).toBe(id)
  expect(detail.character?.latestRequest).toBeNull()
  expect(detail.character?.memory.mode).toBe('native')
  expect(detail.events.items).toHaveLength(2)
  expect(detail.events.hasMore).toBe(true)
  const next = runtime.creatorInspection({ afterSeq: detail.events.nextAfterSeq, limit: 2 })
  expect(next.events.items[0]!.seq).toBeGreaterThan(detail.events.nextAfterSeq)
  expect(() => runtime.creatorInspection({ characterId: 'secret:unknown' })).toThrow('未知角色')
  expect(() => runtime.creatorInspection({ afterSeq: snapshot.headSeq + 1 })).toThrow('时刻')
  const after = await runtime.state()
  expect(after.debug.headSeq).toBe(before.debug.headSeq)
  expect(after.debug.providerCalls).toBe(before.debug.providerCalls)
  snapshot.characters[0]!.name = 'changed'
  expect(runtime.creatorInspection().characters[0]!.name).not.toBe('changed')
})
it('keeps creator data behind host authentication and accepts only bounded GET queries', async () => {
  const runtime = await fixture(),
    token = 'd'.repeat(64),
    server = createHostServer(runtime, token)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  })
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const headers = { 'x-playtest-token': token }
  expect((await fetch(url + '/api/creator-debug')).status).toBe(401)
  expect((await fetch(url + '/api/creator-debug', { headers: { ...headers, origin: 'null' } })).status).toBe(403)
  expect((await fetch(url + '/frontend-api/v1/creator-debug', { headers })).status).toBe(404)
  expect((await fetch(url + '/api/creator-debug', { method: 'POST', headers })).status).toBe(404)
  for (const query of ['limit=101', 'afterSeq=-1', 'limit=1&limit=2', 'path=world.sqlite', 'characterId=missing']) {
    expect((await fetch(url + '/api/creator-debug?' + query, { headers })).status).toBe(400)
  }
  const snapshot = await (await fetch(url + '/api/creator-debug?limit=1', { headers })).json()
  expect(snapshot).toMatchObject({
    captureEnabled: false,
    characters: expect.any(Array),
    events: { items: expect.any(Array) },
  })
})
it('preserves the latest request per character when other characters evict global calls, and clears on disable', () => {
  const inspector = new RequestInspector()
  inspector.configure(true)
  const body = {
    model: 'test',
    messages: [
      { role: 'user', content: JSON.stringify({ context: { history: ['PRIVATE_A'], memories: ['MEMORY_A'] } }) },
    ],
  }
  const first = inspector.begin(body, {
    characterId: 'a',
    continuation: false,
    asOfWorldSeq: 3,
    sources: [{ source: 'context', name: '上下文' }],
  })
  for (let index = 0; index < 5; index++)
    inspector.begin({ ...body, messages: [] }, { characterId: 'b', continuation: true, sources: [] })
  inspector.finish(first, 'ok', 10)
  expect(inspector.snapshot().requests.every(request => request.characterId === 'b')).toBe(true)
  expect(inspector.latest('a')).toMatchObject({
    status: 'ok',
    asOfWorldSeq: 3,
    contextParts: expect.arrayContaining([
      { name: 'memories', content: '["MEMORY_A"]', estimatedTokens: expect.any(Number) },
    ]),
  })
  inspector.latest('a')!.messages[0]!.content = 'changed'
  expect(inspector.latest('a')!.messages[0]!.content).toContain('PRIVATE_A')
  inspector.configure(false)
  expect(inspector.latest('a')).toBeNull()
  expect(() => creatorInspectionQuery({ command: 'write' })).toThrow()
})
