import { createServer, type Server } from 'node:http'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import { WorldStore } from '@harness-world/store-sqlite'
import { currentEntityState } from '@harness-world/kernel'

/**
 * The page's own runtime, driven the way a person drives it - with a local endpoint standing in for a
 * model, so the automatic suite covers the whole path (rendered schema, transport, interpretation, world)
 * without a paid provider. A real endpoint is driven by hand, and by the frozen playtest driver.
 */
const servers: Server[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(close => server.close(() => close()))))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function listening(server: Server): Promise<number> {
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', () => ready()))
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}


// These tests exercise the host's generic transfer mechanism, not the current
// AI-girls pack's gameplay. Declare a local fixture instead of restoring daily
// interactions to the real pack.
function interactionFixture():string {
  const root=mkdtempSync(join(tmpdir(),'frozen-interaction-fixture-'));roots.push(root)
  cpSync(resolve('examples/world-packs/ai-girls-awaken-v10'),root,{recursive:true})
  const definitions=['take','drop'].map(id=>({id:'base:'+id,version:1}))
  writeFileSync(join(root,'entities.json'),JSON.stringify({schemaVersion:'worldpack-entities/v2',
    entities:[{entityId:'entity:phone',locationId:'location:bedroom',kind:'phone',
      interactionBindings:definitions.map(d=>({bindingId:'binding:phone-'+d.id.slice(5),definition:d,config:{}}))}]}))
  writeFileSync(join(root,'interactions.json'),JSON.stringify({schemaVersion:'worldpack-interactions/v1',
    packages:[{id:'package:interactions-basic',version:1}],definitions,relationBindings:[]}))
  return root
}

describe('the web playtest on a frozen world', () => {
  it('revisits emptied rooms and restores NPC speech audiences without revealing isolated speech', async () => {
    const root=mkdtempSync(join(tmpdir(),'empty-room-return-'));roots.push(root)
    const inputs:unknown[]=[]
    const server=createServer((request,response)=>{
      let body='';request.on('data',chunk=>{body+=String(chunk)})
      request.on('end',()=>{
        inputs.push(JSON.parse(JSON.parse(body).messages.at(-1).content))
        response.writeHead(200,{'content-type':'application/json'})
        response.end(JSON.stringify({message:{content:JSON.stringify({decision:'abstain'})}}))
      })
    });servers.push(server)
    const runtime=await FrozenWorldPlaytestRuntime.create({dataDirectory:root,
      packPath:resolve('examples/world-packs/ai-girls-awaken-v10'),provider:'ollama',model:'fixture',
      utilityEndpoint:`http://127.0.0.1:${await listening(server)}/api/chat`})
    try {
      for(const locationId of ['location:living-room','location:kitchen','location:living-room']){
        const state=await runtime.submit('/act move '+JSON.stringify({locationId}))
        expect(state.error).toBe(false)
        expect(state.world.currentScene?.presentNpcNames).toEqual([])
      }
      const count=inputs.length
      await runtime.submit('独处时的隔离标记-7316。')
      expect(inputs).toHaveLength(count)
      const back=await runtime.submit('/act move {"locationId":"location:bedroom"}')
      expect(back.world.currentScene?.presentNpcNames).toHaveLength(4)
      inputs.length=0
      await runtime.submit('我回来了，大家还在吗？')
      expect(inputs).toHaveLength(4)
      expect(JSON.stringify(inputs)).not.toContain('隔离标记-7316')
      const invalid=await runtime.submit('/act move {"locationId":"location:absent"}')
      expect(invalid.world.currentScene?.locationName).toBe(back.world.currentScene?.locationName)
      expect(invalid.world.currentScene?.presentNpcNames).toHaveLength(4)
    } finally {await runtime.close()}
  },30_000)

  it('sends the local Gemini endpoint a flat decision schema with real movement destinations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gemini-flat-tool-')); roots.push(root)
    const schemas: unknown[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        const wire = JSON.parse(body)
        schemas.push(wire.tools[0].function.parameters)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{
          function: { name: 'submit_actions', arguments: '{"decision":"abstain"}' },
        }] } }] }))
      })
    })
    servers.push(server)
    const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: interactionFixture(), provider: 'local',
      model: 'gemini-3.7-flash', memoryShadow: true,
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/v1/chat/completions` })
    try {
      const state = await runtime.submit('/act speak {"text":"早上好。"}')
      expect(state.error).toBe(false)
      const shadow = readFileSync(resolve(root, 'memory-shadow.jsonl'), 'utf8').trim().split('\n')
        .map(line => JSON.parse(line) as { phase: string; characterId: string; asOfWorldSeq: number })
      expect(shadow).toHaveLength(4)
      expect(shadow.every(row => row.phase === 'automatic' && row.asOfWorldSeq > 0)).toBe(true)
      expect(schemas).toHaveLength(4)
      expect((schemas[0] as { oneOf?: unknown }).oneOf).toBeUndefined()
      expect(schemas[0]).toMatchObject({ properties: {
        decision: { enum: expect.arrayContaining(['publish', 'perform']) },
        parameters: { additionalProperties: false, properties: {
          locationId: { enum: expect.arrayContaining(['location:living-room']) },
        } },
      } })
    } finally { await runtime.close() }
  })
  it('runs two committed operations and a final expression in one default character activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'activation-two-operations-')); roots.push(root)
    let claudeCalls = 0
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        const wire = JSON.parse(body)
        const input = JSON.parse(wire.messages.at(-1).content)
        let answer: unknown = { decision: 'abstain' }
        if (input.context.character.characterId === 'character:claude') {
          claudeCalls++
          if (claudeCalls <= 2) {
            expect(input.canPerform).toBe(true)
            if (claudeCalls === 2) expect(input.result.status).toBe('accepted')
            const definition = claudeCalls === 1 ? 'take' : 'drop'
            answer = { decision: 'perform', actionType: 'interact', parameters: {
              targetRef: { kind: 'entity', id: 'entity:phone' }, bindingId: `binding:phone-${definition}`,
              definitionRef: { id: `base:${definition}`, version: 1 }, arguments: {},
            } }
          } else {
            expect(input.canPerform).toBe(false)
            expect(input.result.status).toBe('accepted')
            answer = { decision: 'publish', speech: '看过手机后放回桌上。' }
          }
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
      })
    })
    servers.push(server)
    const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: interactionFixture(), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat` })
    try {
      const state = await runtime.submit('/act speak {"text":"大家早安。"}')
      expect(state.error).toBe(false)
      expect(claudeCalls).toBe(3)
      expect(state.transcript.some(line => line.text.includes('看过手机后放回桌上'))).toBe(true)
      const store = new WorldStore(resolve(root, 'world.sqlite'))
      try {
        const events = store.readEvents(runtime.address)
        expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(2)
        expect(currentEntityState(events, 'entity:phone')?.holderId).toBeNull()
      } finally { store.close() }
    } finally { await runtime.close() }
  }, 30_000)

  it('drops a character operation returned after the page pauses the activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'activation-pause-')); roots.push(root)
    let wake!: () => void
    const started = new Promise<void>(resolve => { wake = resolve })
    let finish!: () => void
    const release = new Promise<void>(resolve => { finish = resolve })
    const server = createServer(async (_request, response) => {
      wake()
      await release
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify({ decision: 'perform', actionType: 'interact', parameters: {
        targetRef: { kind: 'entity', id: 'entity:phone' }, bindingId: 'binding:phone-take',
        definitionRef: { id: 'base:take', version: 1 }, arguments: {},
      } }) } }))
    })
    servers.push(server)
    const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: interactionFixture(), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat` })
    try {
      const pending = runtime.submit('/act speak {"text":"大家早安。"}')
      await started
      await runtime.pause()
      finish()
      const state = await pending
      expect(state.error).toBe(true)
      expect(state.notice).toContain('打断或超时')
      const store = new WorldStore(resolve(root, 'world.sqlite'))
      try { expect(store.readEvents(runtime.address).filter(event => event.eventType === 'entity.transferred')).toHaveLength(0) }
      finally { store.close() }
    } finally { finish(); await runtime.close() }
  }, 30_000)

  it('reports an invalid continuation, keeps the committed item transfer, and does not replay it on reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'activation-reopen-')); roots.push(root)
    let calls = 0
    const server = createServer((_request, response) => {
      calls++
      const answer = calls === 1 ? { decision: 'perform', actionType: 'interact', parameters: {
        targetRef: { kind: 'entity', id: 'entity:phone' }, bindingId: 'binding:phone-take',
        definitionRef: { id: 'base:take', version: 1 }, arguments: {},
      } } : calls === 2 ? { decision: 'publish', speech: '没完成的续写', extra: true }
        : { decision: 'abstain' }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
    })
    servers.push(server)
    const port = await listening(server)
    const open = () => FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: interactionFixture(), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${port}/api/chat` })
    const first = await open()
    let initialHead: number
    try {
      const state = await first.submit('/act speak {"text":"大家早安。"}')
      expect(state.error).toBe(true)
      expect(state.notice).toContain('格式无效')
      expect(state.notice).toContain('交互结果已提交，后续表达未完成')
      expect(state.transcript.some(line => line.text.includes('没完成的续写'))).toBe(false)
      const store = new WorldStore(resolve(root, 'world.sqlite'))
      try {
        const events = store.readEvents(first.address)
        expect(currentEntityState(events, 'entity:phone')?.holderId).toBe('character:claude')
        expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(1)
        initialHead = store.head(first.address).headSeq
      } finally { store.close() }
    } finally { await first.close() }
    const callsBeforeReopen = calls
    const reopened = await open()
    try {
      const state = await reopened.state()
      expect(calls).toBe(callsBeforeReopen)
      expect(state.debug.headSeq).toBe(initialHead!)
      const store = new WorldStore(resolve(root, 'world.sqlite'))
      try { expect(store.readEvents(reopened.address).filter(event => event.eventType === 'entity.transferred')).toHaveLength(1) }
      finally { store.close() }
    } finally { await reopened.close() }
  }, 30_000)

  it('activates all NPCs sequentially, with take and move results before anyone else is called', async () => {
    const root = mkdtempSync(join(tmpdir(), 'single-activation-web-')); roots.push(root)
    const seen: { actor: string; continuation: boolean }[] = []
    const acted = new Set<string>()
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        const wire = JSON.parse(body)
        const input = JSON.parse(wire.messages.at(-1).content)
        const actor = input.context.character.characterId as string
        seen.push({ actor, continuation: input.continuation })
        let answer: unknown = { decision: 'abstain' }
        if (input.continuation) {
          expect(input.result.status).toBe('accepted')
          const store = new WorldStore(resolve(root, 'world.sqlite'))
          try {
            const address = store.listBranches()[0]!
            const events = store.readEvents(address)
            if (actor === 'character:claude') {
              expect(currentEntityState(events, 'entity:phone')?.holderId).toBe(actor)
              answer = { decision: 'publish', speech: '手机拿到了。' }
            } else {
              expect(input.context.scene.locationId).toBe('location:workspace')
              answer = { decision: 'publish', speech: '我到工作区了。' }
            }
          } finally { store.close() }
        } else if (!acted.has(actor)) {
          acted.add(actor)
          if (actor === 'character:claude') answer = { decision: 'perform', actionType: 'interact', parameters: {
            targetRef: { kind: 'entity', id: 'entity:phone' }, bindingId: 'binding:phone-take',
            definitionRef: { id: 'base:take', version: 1 }, arguments: {},
          } }
          if (actor === 'character:deepseek') answer = { decision: 'perform', actionType: 'move',
            parameters: { locationId: 'location:workspace' } }
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
      })
    })
    servers.push(server)
    const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: interactionFixture(), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat` })
    try {
      const state = await runtime.submit('/act speak {"text":"大家早安。"}')
      expect(state.error).toBe(false)
      expect(seen.slice(0, 4)).toEqual([
        { actor: 'character:claude', continuation: false }, { actor: 'character:claude', continuation: true },
        { actor: 'character:deepseek', continuation: false }, { actor: 'character:deepseek', continuation: true },
      ])
      expect(new Set(seen.map(entry => entry.actor)).size).toBe(4)
      expect(seen.length).toBeLessThanOrEqual(8)
      expect(state.transcript.some(line => line.text.includes('手机拿到了'))).toBe(true)
      expect(state.transcript.some(line => line.text.includes('我到工作区了'))).toBe(false)
      expect(state.debug.outputProtocol).toBe('perform/publish/abstain')
    } finally { await runtime.close() }
  }, 30_000)

  it('does not schedule another wave for ordinary nonverbal publications', async () => {
    const root = mkdtempSync(join(tmpdir(), 'single-expression-web-')); roots.push(root)
    let calls = 0
    const server = createServer((_request, response) => {
      calls++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify({ decision: 'publish', narration: '轻轻点头。' }) } }))
    })
    servers.push(server)
    const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: interactionFixture(), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat` })
    try {
      const state = await runtime.submit('/act speak {"text":"大家早安。"}')
      expect(calls).toBe(4)
      expect(state.debug.activationCycle).toMatchObject({ calls: 4, wave: 1, terminalReason: 'quiescent' })
      expect(state.transcript.filter(line => line.text.includes('轻轻点头')).length).toBe(4)
    } finally { await runtime.close() }
  }, 30_000)

  it('offers NPCs a first reaction to the player’s pure nonverbal expression', async () => {
    const root = mkdtempSync(join(tmpdir(), 'player-expression-activation-')); roots.push(root)
    let calls = 0
    const server = createServer((_request, response) => {
      calls++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify({ decision: 'abstain' }) } }))
    })
    servers.push(server)
    const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: interactionFixture(), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat` })
    try {
      const state = await runtime.submit('/act speak {"text":"","narration":"有点尴尬地笑了笑。"}')
      expect(state.error).toBe(false)
      expect(calls).toBe(4)
      expect(state.debug.activationCycle).toMatchObject({ calls: 4, wave: 1, terminalReason: 'quiescent' })
    } finally { await runtime.close() }
  }, 30_000)

  it('keeps compound player words intact and never dispatches an intent request', async () => {
    let intentCalls = 0
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        if (body.includes('player-intent-candidate')) intentCalls++
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: { content: JSON.stringify({ decision: 'abstain' }) } }))
      })
    })
    servers.push(server)
    const root = mkdtempSync(join(tmpdir(), 'frozen-command-mode-')); roots.push(root)
    const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: resolve('examples/world-packs/prototype-g1'), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat` })
    try {
      const before = await runtime.state()
      const state = await runtime.submit('我轻轻笑了笑，走进后室看看有没有锁。')
      expect(state.error).toBe(false)
      expect(state.world.currentScene?.locationName).toBe(before.world.currentScene?.locationName)
      expect(state.debug.playerInputMode).toBe('command-controlled')
      expect(JSON.stringify(state)).toContain('我轻轻笑了笑，走进后室看看有没有锁。')
      expect(intentCalls).toBe(0)
      const malformed = await runtime.submit('/move')
      expect(malformed.notice).toContain('请检查命令参数')
      expect(malformed.debug.lastPlayerIntent).toBe('clarification')
      const moved = await runtime.submit('/move location:back-room')
      expect(moved.world.currentScene?.locationName).toBe('后室')
      expect(intentCalls).toBe(0)
    } finally { await runtime.close() }
  }, 30_000)
})
