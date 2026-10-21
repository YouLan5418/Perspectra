import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { WorldHostCore, type WorldHostOptions } from '../../desktop/host/world-runtime.ts'
import { createHostServer } from '../../desktop/host/http-server.ts'
import { CreatorRecords } from '../../desktop/host/creator-records.ts'
import { RequestInspector } from '../../packages/provider-chat/src/request-inspector.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function fixture(extra: Partial<WorldHostOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'creator-observability-'))
  cleanups.push(async () => {
    rmSync(root, { recursive: true, force: true })
  })
  const provider = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"decision":"abstain"}', reasoning_content: 'CREATOR_ONLY_THOUGHT' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
          headers: { authorization: 'MUST_NOT_CAPTURE' },
        }),
      )
    })
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  cleanups.push(async () => {
    provider.closeAllConnections()
    await new Promise<void>(done => provider.close(() => done()))
  })
  const options: WorldHostOptions = {
    packPath: resolve('examples/world-packs/prototype-g1'),
    dataDirectory: root,
    provider: 'local',
    model: 'fixture',
    utilityEndpoint: 'http://127.0.0.1:' + (provider.address() as AddressInfo).port + '/v1/chat/completions',
    ...extra,
  }
  const runtime = await WorldHostCore.create(options)
  cleanups.push(() => runtime.close())
  return { root, runtime, options }
}
it('keeps complete captured requests after recent-call eviction, disable and restart, with exact preset snapshots', async () => {
  const groupId = randomUUID()
  const { root, runtime, options } = await fixture({
    presetMapping: {
      groups: {
        [groupId]: {
          name: '同行角色组',
          preset: {
            nodes: [
              {
                id: 'style',
                name: '文风',
                enabled: true,
                role: 'system',
                position: 'beforeContext',
                content: '{{char}}保持简短',
              },
            ],
          },
        },
      },
      memberships: { 'character:companion': groupId },
    },
  })
  runtime.requestInspection(true)
  for (let index = 0; index < 3; index++) await runtime.submit('第' + index + '次测试')
  const before = await runtime.state(),
    page = runtime.creatorRecords({ kind: 'request', limit: 1 })
  expect(page.total).toBeGreaterThan(4)
  expect(page.hasMore).toBe(true)
  expect(runtime.requestInspection().requests).toHaveLength(4)
  const summaries = runtime.creatorRecords({ kind: 'request', characterId: 'character:companion', limit: 100 })
  const captured = runtime.creatorRecords({ recordId: summaries.items[0]!.id }).record!
  expect(captured.data).toMatchObject({
    response: { content: ['{"decision":"abstain"}'], thinking: [{ kind: 'text', text: 'CREATOR_ONLY_THOUGHT' }] },
    preset: {
      origin: { scope: 'group', groupId, name: '同行角色组' },
      value: { nodes: [{ id: 'style', content: '{{char}}保持简短' }] },
    },
  })
  expect(JSON.stringify(captured)).not.toContain('MUST_NOT_CAPTURE')
  expect(JSON.stringify(projectPlayerView(await runtime.state()))).not.toContain('CREATOR_ONLY_THOUGHT')
  expect((await runtime.state()).debug.providerCalls).toBe(before.debug.providerCalls)
  const detached = runtime.creatorRecords()
  detached.scope.branchId = 'changed'
  expect(runtime.creatorRecords().scope.branchId).not.toBe('changed')
  runtime.requestInspection(false)
  expect(runtime.creatorRecords({ kind: 'request' }).total).toBe(page.total)
  await runtime.close()
  const restored = await WorldHostCore.create({ ...options, dataDirectory: root })
  cleanups.push(() => restored.close())
  expect(restored.requestInspection().enabled).toBe(false)
  expect(restored.creatorRecords({ recordId: captured.id }).record).toEqual(captured)
  restored.requestInspection(true)
  await restored.close()
  const enabled = await WorldHostCore.create(options)
  cleanups.push(() => enabled.close())
  expect(enabled.requestInspection().enabled).toBe(true)
})
it('links custody changes, rejected attempts and holder movement without making dialogue a transfer', async () => {
  const { runtime } = await fixture()
  const parameters = {
    targetRef: { kind: 'entity', id: 'entity:brass-key' },
    bindingId: 'binding:key-take',
    definitionRef: { id: 'base:take', version: 1 },
    arguments: {},
  }
  await runtime.perform({ actionType: 'interact', parameters })
  await runtime.perform({ actionType: 'interact', parameters })
  await runtime.submit('我说我把钥匙交给同行者了。')
  const destination = (await runtime.state()).availableActions!.find(action => action.actionType === 'move')!
    .destinations![0]!
  await runtime.perform({ actionType: 'move', parameters: { locationId: destination.locationId } })
  const history = runtime.creatorHistory({ entityId: 'entity:brass-key', limit: 100 })
  const transfer = history.items.find(item => item.event.eventType === 'entity.transferred')!
  expect(transfer.entityChange).toMatchObject({
    before: { holderId: null },
    after: { holderId: 'character:player' },
    followsHolder: false,
  })
  const rejected = history.items.find(
    item => item.event.eventType === 'action.resolved' && (item.event.data as { accepted: boolean }).accepted === false,
  )!
  expect(rejected.action).toMatchObject({ parameters })
  expect(rejected.entityChange).toBeNull()
  const movement = history.items.find(item => item.entityChange?.followsHolder)!
  expect(movement.event.eventType).toBe('character.moved')
  expect(runtime.creatorInspection().entities.find(item => item.id === 'entity:brass-key')?.state.holderId).toBe(
    'character:player',
  )
  const first = runtime.creatorHistory({ entityId: 'entity:brass-key', limit: 1 })
  expect(first.hasMore).toBe(true)
  expect(
    runtime.creatorHistory({ entityId: 'entity:brass-key', afterSeq: first.nextAfterSeq, limit: 100 }).items[0]!.event
      .seq,
  ).toBeGreaterThan(first.nextAfterSeq)
})
it('reports actual private recipients across page boundaries and does not confuse addressees with witnesses', async () => {
  const { runtime } = await fixture()
  await runtime.submit(
    '/act speak ' +
      JSON.stringify({ text: 'PRIVATE_DIALOGUE', scope: 'private', addresseeIds: ['character:companion'] }),
  )
  const speech = runtime.creatorHistory({ eventType: 'character.speak', search: 'PRIVATE_DIALOGUE', limit: 1 })
    .items[0]!
  expect(speech.event.data).toMatchObject({ scope: 'private', addresseeIds: ['character:companion'] })
  expect(speech.recipients).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ characterId: 'character:companion', visibility: 'full' }),
      expect.objectContaining({ characterId: 'character:friend', visibility: 'occurrence_only' }),
    ]),
  )
  expect(runtime.creatorHistory({ eventSeq: speech.event.seq, limit: 1 }).items[0]).toEqual(speech)
  expect(speech.relatedSeqs.length).toBeGreaterThan(1)
})
it('keeps record details and event history behind host authentication with bounded, strict queries', async () => {
  const { runtime } = await fixture(),
    token = 'a'.repeat(64),
    server = createHostServer(runtime, token)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  })
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    headers = { 'x-playtest-token': token }
  for (const endpoint of ['creator-history', 'creator-records']) {
    expect((await fetch(base + '/api/' + endpoint)).status).toBe(401)
    expect((await fetch(base + '/api/' + endpoint, { headers: { ...headers, origin: 'null' } })).status).toBe(403)
    expect((await fetch(base + '/frontend-api/v1/' + endpoint, { headers })).status).toBe(404)
    for (const query of ['limit=101', 'limit=1&limit=2', 'path=secret', 'offset=-1'])
      expect((await fetch(base + '/api/' + endpoint + '?' + query, { headers })).status).toBe(400)
    expect((await fetch(base + '/api/' + endpoint + '?limit=1', { headers })).status).toBe(200)
  }
  expect((await fetch(base + '/api/creator-history?entityId=missing', { headers })).status).toBe(400)
  expect((await fetch(base + '/api/creator-records?recordId=../../secret', { headers })).status).toBe(400)
})
it('separates branches, preserves unfinished captures, and exposes corrupt or unwritable diagnostic storage', async () => {
  const { root, runtime } = await fixture(),
    scope = runtime.creatorRecords().scope
  const a = new CreatorRecords(root, scope),
    b = new CreatorRecords(root, { ...scope, branchId: 'candidate-b' })
  a.configure(true)
  const inspector = new RequestInspector(request => a.save(request))
  inspector.configure(true)
  const pending = inspector.begin(
    { model: 'm', messages: [] },
    { characterId: 'character:companion', continuation: false, sources: [] },
  )!
  b.trace('turn', 'character:friend', null, { status: 'abstained' })
  expect(a.query({}, true).items.every(item => item.scope.branchId === scope.branchId)).toBe(true)
  expect(a.query({ branchId: 'candidate-b' }, true).items).toHaveLength(1)
  expect(a.query({}, true).branches).toContain('candidate-b')
  const id = inspector.snapshot().requests[0]!.recordId
  expect(a.query({ recordId: id }, true).record?.data).toMatchObject({ status: 'pending' })
  for (let index = 0; index < 5; index++)
    inspector.begin({ model: 'm', messages: [] }, { characterId: 'other', continuation: false, sources: [] })
  inspector.finish(pending, 'ok', 5)
  expect(a.query({ recordId: id }, true).record?.data).toMatchObject({ status: 'ok' })
  writeFileSync(join(root, 'creator-debug', 'records', id + '.json'), '{}')
  expect(() => a.query({}, true)).toThrow('损坏')
  const blocked = join(root, 'blocked')
  writeFileSync(blocked, 'file')
  const unwritable = new CreatorRecords(blocked, scope)
  unwritable.trace('turn', 'character:friend', null, { status: 'abstained' })
  expect(unwritable.error).toContain('写入失败')
})
