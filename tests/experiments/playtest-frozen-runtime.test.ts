import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
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

describe('the web playtest on a frozen world', () => {
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
      packPath: resolve('examples/world-packs/ai-girls-awaken-v10'), provider: 'ollama', model: 'fixture',
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
      packPath: resolve('examples/world-packs/ai-girls-awaken-v10'), provider: 'ollama', model: 'fixture',
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
      packPath: resolve('examples/world-packs/ai-girls-awaken-v10'), provider: 'ollama', model: 'fixture',
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
      packPath: resolve('examples/world-packs/ai-girls-awaken-v10'), provider: 'ollama', model: 'fixture',
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
      packPath: resolve('examples/world-packs/ai-girls-awaken-v10'), provider: 'ollama', model: 'fixture',
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
      packPath: resolve('examples/world-packs/ai-girls-awaken-v10'), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat` })
    try {
      const state = await runtime.submit('/act speak {"text":"","narration":"有点尴尬地笑了笑。"}')
      expect(state.error).toBe(false)
      expect(calls).toBe(4)
      expect(state.debug.activationCycle).toMatchObject({ calls: 4, wave: 1, terminalReason: 'quiescent' })
    } finally { await runtime.close() }
  }, 30_000)

  it('reports provider rejection without asking the player to rephrase', async () => {
    const server = createServer((_request, response) => { response.writeHead(402); response.end('{}') })
    servers.push(server)
    const root = mkdtempSync(join(tmpdir(), 'frozen-provider-failure-')); roots.push(root)
    const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: resolve('examples/world-packs/prototype-g1'), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat` })
    try {
      const state = await runtime.submit('你好。')
      expect(state.error).toBe(true)
      expect(state.notice).toContain('模型服务暂时无法完成请求')
      expect(state.notice).not.toMatch(/换一种说法|显式命令/)
      expect(state.debug.lastPlayerIntent).toBe('service-failed')
      const clarification = await runtime.submit('/move')
      expect(clarification.error).toBe(false)
      expect(clarification.notice).toContain('换一种说法')
      expect(clarification.debug.lastPlayerIntent).toBe('clarification')
    } finally { await runtime.close() }
  }, 30_000)

  it('identifies an HTTP 200 invalid player-intent answer as model output failure, not service outage', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify({
        version: 'player-intent-candidate/v3', decision: 'act', reason: 'none',
        actions: [{ key: 'invented', affordanceId: 'not-an-offered-option', quotes: ['我想看看。'] }],
      }) } }))
    })
    servers.push(server)
    const root = mkdtempSync(join(tmpdir(), 'frozen-invalid-intent-')); roots.push(root)
    const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: resolve('examples/world-packs/prototype-g1'), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat` })
    try {
      const before = await runtime.state()
      const state = await runtime.submit('我想看看。')
      expect(state.error).toBe(true)
      expect(state.notice).toContain('输入解释格式无效')
      expect(state.notice).toContain('原文已保留')
      expect(state.debug.lastPlayerIntent).toBe('model-output-invalid')
      expect(state.debug.headSeq).toBe(before.debug.headSeq)
    } finally { await runtime.close() }
  }, 30_000)

  it('rejects the recorded performance/move order, then commits the same sentence in source order', async () => {
    let reverse = true
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        const wire = JSON.parse(body)
        let answer: unknown = { decision: 'abstain' }
        if (JSON.stringify(wire.format).includes('player-intent-candidate')) {
          const input = JSON.parse(wire.messages.at(-1).content)
          const move = input.affordances.find((choice: any) => choice.actionType === 'move'
            && choice.parameters.locationId === 'location:back-room')
          expect(move).toBeDefined()
          const actions = [
            { key: 'expression', affordanceId: 'narrate', quotes: ['我轻轻笑了笑'] },
            { key: 'movement', affordanceId: move.affordanceId, quotes: ['走进后室看看有没有锁'] },
          ]
          answer = { version: 'player-intent-candidate/v3', decision: 'act', reason: 'none',
            actions: reverse ? actions.reverse() : actions }
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
      })
    })
    servers.push(server)
    const root = mkdtempSync(join(tmpdir(), 'frozen-expression-move-')); roots.push(root)
    const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: resolve('examples/world-packs/prototype-g1'), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat` })
    try {
      const before = await runtime.state()
      const text = '我轻轻笑了笑，走进后室看看有没有锁。'
      const failed = await runtime.submit(text)
      expect(failed.error).toBe(true)
      expect(failed.notice).toContain('与原文不符的顺序')
      expect(failed.notice).toContain('这次输入没有提交')
      expect(failed.debug.headSeq).toBe(before.debug.headSeq)
      reverse = false
      const committed = await runtime.submit(text)
      expect(committed.error).toBe(false)
      expect(committed.debug.headSeq).toBeGreaterThan(before.debug.headSeq as number)
      expect(committed.world.currentScene?.locationName).toBe('后室')
    } finally { await runtime.close() }
  }, 30_000)

  it('shows omitted trailing player words even when the earlier movement was committed', async () => {
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        const wire = JSON.parse(body)
        let answer: unknown = { decision: 'abstain' }
        if (JSON.stringify(wire.format).includes('player-intent-candidate')) {
          const input = JSON.parse(wire.messages.at(-1).content)
          const move = input.affordances.find((choice: any) => choice.actionType === 'move'
            && choice.parameters.locationId === 'location:back-room')
          answer = { version: 'player-intent-candidate/v3', decision: 'act', reason: 'none',
            actions: [{ key: 'move', affordanceId: move.affordanceId, quotes: ['我走进后室'] }] }
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
      })
    })
    servers.push(server)
    const root = mkdtempSync(join(tmpdir(), 'frozen-missing-tail-')); roots.push(root)
    const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: resolve('examples/world-packs/prototype-g1'), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat` })
    try {
      const state = await runtime.submit('我走进后室看看有没有锁。')
      expect(state.error).toBe(false)
      expect(state.world.currentScene?.locationName).toBe('后室')
      expect(state.notice).toContain('句尾“看看有没有锁”没有映射到本次动作或表达')
      expect(state.notice).toContain('请以转录和当前场景为准')
    } finally { await runtime.close() }
  }, 30_000)


})
