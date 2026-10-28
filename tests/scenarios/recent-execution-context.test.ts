import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { WorldStore } from '@harness-world/store-sqlite'
import { currentEntityState } from '@harness-world/kernel'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { restoreStoryNode } from '../../desktop/story-nodes.ts'
import { playSettings } from '../../desktop/play-settings.ts'
import type { CoreRunner } from '../../desktop/host/memory/python-worker.ts'
import { createChatServer, fakeModels } from '../support/fake-provider.ts'

it('keeps disabled requests unchanged and isolates private evidence across a real saved-node fork', async () => {
  const root = mkdtempSync(join(tmpdir(), 'execution-context-')),
    requests: Record<string, any>[] = []
  let action: 'none' | 'move' | 'take' = 'none'
  const server = createChatServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404)
      response.end()
      return
    }
    let body = ''
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      const wire = JSON.parse(body),
        input = JSON.parse(wire.messages.findLast((m: { role: string }) => m.role === 'user').content)
      requests.push({ wire, input })
      let decision: unknown = { decision: 'abstain' }
      if (input.context.character.characterId === 'character:friend' && !input.continuation && action !== 'none') {
        decision =
          action === 'move'
            ? { decision: 'perform', actionType: 'move', parameters: { locationId: 'location:front-room' } }
            : {
                decision: 'perform',
                actionType: 'interact',
                parameters: {
                  targetRef: { kind: 'entity', id: 'entity:brass-key' },
                  bindingId: 'status',
                  definitionRef: { id: 'status:take', version: 1 },
                  arguments: {},
                },
              }
        action = 'none'
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }))
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const packPath = join(root, 'pack')
  cpSync(resolve('examples/world-packs/character-autonomy'), packPath, { recursive: true })
  const autonomy = JSON.parse(readFileSync(join(packPath, 'autonomy.json'), 'utf8'))
  autonomy.characters[0].interactions = ['status:take']
  writeFileSync(join(packPath, 'autonomy.json'), JSON.stringify(autonomy))
  const data = join(root, 'world'),
    settings = playSettings({ autonomyNpcCalls: 8, autonomyReactionCalls: 8 })
  const core: CoreRunner = async input =>
    input.operation === 'build'
      ? {
          archive: { scope: input.scope!, sources: input.sources!, facts: [], episodes: [], observations: [] },
          index: { scope: input.scope!, units: [], vectors: [] },
        }
      : { delivery: [], deliveryTrace: { delivered: [], activityCoverage: [] } }
  const options = {
    packPath,
    dataDirectory: data,
    models: fakeModels(`http://127.0.0.1:${port}/v1/chat/completions`, 'openai', 'fixture'),
    playSettings: settings,
    storyNodes: true,
    memoryCore: true,
    memoryCoreRun: core,
    memoryCoreBuildRun: core,
  }
  let runtime: WorldHostRuntime | undefined
  try {
    runtime = await WorldHostRuntime.create(options)
    action = 'move'
    await runtime.submit('/act speak {"text":"普通基线机会","scope":"self"}')
    expect(requests.every(r => r.input.context.recentExecutionEvidence === undefined)).toBe(true)
    expect(requests.every(r => !r.wire.messages[0].content.includes('recentExecutionEvidence 是'))).toBe(true)
    const node = await runtime.saveNode('执行证据分叉前')
    const store = new WorldStore(join(data, 'world.sqlite'))
    const prefix = store.head(runtime.address).headSeq
    store.close()
    await runtime.close()
    runtime = await WorldHostRuntime.create({ ...options, recentExecutionEvidence: true })
    // The fixture author permits take; this remains a real Rulebook commit, not an injected possession event.
    action = 'take'
    await runtime.submit('/act speak {"text":"请自行处理眼前的物品。","scope":"scene_public"}')
    const futureStore = new WorldStore(join(data, 'world.sqlite'))
    const future = futureStore.readEvents(runtime.address)
    futureStore.close()
    expect(currentEntityState(future, 'entity:brass-key')?.holderId).toBe('character:friend')
    expect(future.some(e => e.seq > prefix && e.eventType === 'entity.transferred')).toBe(true)
    await runtime.close()
    runtime = undefined
    const child = join(root, 'child')
    restoreStoryNode(data, node.id, child, node.packHash)
    runtime = await WorldHostRuntime.create({ ...options, dataDirectory: child, recentExecutionEvidence: true })
    requests.length = 0
    await runtime.submit('/act speak {"text":"私语隔离青松","scope":"private","addresseeIds":["character:companion"]}')
    const friend = requests.filter(r => r.input.context.character.characterId === 'character:friend')
    expect(friend.length).toBeGreaterThan(0)
    expect(JSON.stringify(friend)).not.toContain('私语隔离青松')
    expect(
      friend.some(r =>
        r.input.context.recentExecutionEvidence?.items.some((e: { actionType: string }) => e.actionType === 'move'),
      ),
    ).toBe(true)
    expect(JSON.stringify(friend.map(r => r.input.context.recentExecutionEvidence))).not.toContain('status:take')
    const childStore = new WorldStore(join(child, 'world.sqlite'))
    expect(currentEntityState(childStore.readEvents(runtime.address), 'entity:brass-key')?.holderId).toBeNull()
    expect(childStore.verifyBranchIntegrity(runtime.address).headSeq).toBeGreaterThan(prefix)
    childStore.close()
  } finally {
    await runtime?.close()
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
