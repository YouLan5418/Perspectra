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

interface Asked {
  readonly messages: readonly { readonly role: string; readonly content: string }[]
  readonly format: { readonly properties?: Readonly<Record<string, { readonly const?: unknown }>> }
}

/** One option the world offered, as the interpreter sees it. */
interface Offered { readonly affordanceId: string; readonly actionType: string
  readonly parameters: { readonly bindingId?: string } }

/**
 * An endpoint standing in for one vendor: it abstains for a character call and, for an interpretation,
 * answers with the option the test's chooser names - which is what an interpreter does with the player's
 * words, and why the chooser is the test's to state rather than the adapter's to guess.
 */
function scriptedEndpoint(choose: (offered: readonly Offered[]) => Offered,
  speakOnce: boolean | 'dialogue-then-expression' | 'dialogue-then-abstain' = false) {
  const asked: Asked[] = []
  const spoken = new Set<string>()
  const expressed = new Set<string>()
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as Asked
      asked.push(parsed)
      let answer
      if (JSON.stringify(parsed.format).includes('player-intent-candidate')) {
        answer = interpretation(parsed, choose)
      } else if (speakOnce) {
        const variants = ((parsed.format.properties as any).actions.items.oneOf ?? [
          (parsed.format.properties as any).actions.items]) as any[]
        const speech = variants.find(variant => variant.properties.actionType.const === 'speak')
        const actorId = speech?.properties.actorId.const as string | undefined
        if (actorId !== undefined && !spoken.has(actorId)) {
          spoken.add(actorId)
          answer = { schemaVersion: 7, decision: 'act', actions: [{ actionId: `action:scripted:${actorId}`,
            actorId, actionType: 'speak', actionVersion: 1, parameters: { text: '', narration: '指尖蜷起，又慢慢松开。' } }] }
          if (typeof speakOnce === 'string') answer.actions[0]!.parameters.text = '你好。'
        } else if (actorId !== undefined && speakOnce === 'dialogue-then-expression' && !expressed.has(actorId)) {
          expressed.add(actorId)
          answer = { schemaVersion: 7, decision: 'act', actions: [{ actionId: `action:expression:${actorId}`,
            actorId, actionType: 'speak', actionVersion: 1, parameters: { text: '', narration: '轻轻点头。' } }] }
        } else answer = { schemaVersion: 7, decision: 'abstain', actions: [] }
      } else answer = { schemaVersion: 7, decision: 'abstain', actions: [] }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
    })
  })
  servers.push(server)
  return { asked, server }
}

/** The player's own words, mapped onto the option they name, with the span that carries them. */
function interpretation(asked: Asked, choose: (offered: readonly Offered[]) => Offered) {
  // What the Host asked the interpreter: its own contract in the system message, and the player's words
  // beside the exact options in the user message. The adapter renders it; the test reads it back.
  const user = JSON.parse(asked.messages[asked.messages.length - 1]!.content) as {
    readonly sourceText: string; readonly affordances: readonly Offered[] }
  const chosen = choose(user.affordances)
  // The interpreter copies the player's own words; the Host is what turns them into offsets.
  return { version: 'player-intent-candidate/v3', decision: 'act', reason: 'none',
    actions: [{ key: 'a', affordanceId: chosen.affordanceId, quotes: [user.sourceText] }] }
}

/** The option whose binding the player's words named, which is what a real interpreter would select. */
const takesBinding = (binding: string) => (offered: readonly Offered[]) =>
  offered.find(entry => entry.parameters.bindingId === binding)!

/** The move option, which carries the places the world offered rather than a place to invent. */
const moving = (offered: readonly Offered[]) => offered.find(entry => entry.actionType === 'move')!

async function listening(server: Server): Promise<number> {
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', () => ready()))
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

const packPath = resolve('examples/world-packs/hand-in-hand')

/** The endpoint stands in for both the character model and the interpreter, as one vendor would. */
const play = async (asked: readonly Asked[], server: Server, root: string) =>
  await FrozenWorldPlaytestRuntime.create({ singleCharacterActivations: false, dataDirectory: root, packPath, provider: 'ollama',
    model: 'scripted-endpoint/v1', utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat`,
    timeoutMs: 10_000 })

describe('the web playtest on a frozen world', () => {
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

  it('reports provider rejection without asking the player to rephrase', async () => {
    const server = createServer((_request, response) => { response.writeHead(402); response.end('{}') })
    servers.push(server)
    const root = mkdtempSync(join(tmpdir(), 'frozen-provider-failure-')); roots.push(root)
    const runtime = await play([], server, root)
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

  it.each([[false, false], [true, false], [true, true]])('continues a committed item operation (Reaction: %s, rejected: %s)', async (reuseReaction, rejected) => {
    const root = mkdtempSync(join(tmpdir(), 'frozen-perform-integration-'))
    roots.push(root)
    let performed = false
    let continuationCount = 0
    let heldBeforeContinuation: unknown
    let actualContinuation: unknown
    let continuationMessages: unknown
    const narration = rejected ? '轻轻收回了手。' : '低头看着手中的伞，轻轻点头。'
    const spoken = new Set<string>()
    let runtime: FrozenWorldPlaytestRuntime
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body)
        let answer: unknown = { schemaVersion: 7, decision: 'abstain', actions: [] }
        if (parsed.format.oneOf !== undefined) {
          continuationCount += 1
          actualContinuation = JSON.parse(parsed.messages.at(-1).content)
          continuationMessages = parsed.messages
          const store = new WorldStore(join(root, 'world.sqlite'))
          try { heldBeforeContinuation = currentEntityState(store.readEvents(runtime.address), 'entity:shared-umbrella')?.holderId }
          finally { store.close() }
          answer = { decision: 'publish', narration }
        } else {
          const items = parsed.format.properties.actions.items
          const variants = items.oneOf ?? [items]
          const actorId = variants[0]?.properties.actorId.const
          const lastMessage = parsed.messages.at(-1).content
          if (lastMessage.includes('"executionResult"')) {
            continuationCount += 1
            actualContinuation = JSON.parse(lastMessage)
            continuationMessages = parsed.messages
            const store = new WorldStore(join(root, 'world.sqlite'))
            try { heldBeforeContinuation = currentEntityState(store.readEvents(runtime.address), 'entity:shared-umbrella')?.holderId }
            finally { store.close() }
            answer = { schemaVersion: 7, decision: 'act', actions: [{ actionId: 'action:after-take', actorId,
              actionType: 'speak', actionVersion: 1, parameters: { text: '', narration } }] }
          } else if (reuseReaction && actorId !== 'character:companion' && !spoken.has(actorId)) {
            spoken.add(actorId)
            answer = { schemaVersion: 7, decision: 'act', actions: [{ actionId: 'action:other-speaks', actorId,
              actionType: 'speak', actionVersion: 1, parameters: { text: '雨快停了。' } }] }
          } else if (actorId === 'character:companion' && !performed) {
            performed = true
            answer = { schemaVersion: 7, decision: 'act', actions: [{ actionId: 'action:take-umbrella', actorId,
              actionType: 'interact', actionVersion: 2, parameters: {
                targetRef: { kind: 'entity', id: 'entity:shared-umbrella' }, bindingId: 'binding:umbrella-take',
                definitionRef: { id: 'base:take', version: 1 }, arguments: {},
              } }] }
          }
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
      })
    })
    servers.push(server)
    runtime = await FrozenWorldPlaytestRuntime.create({ singleCharacterActivations: false, dataDirectory: root, packPath, provider: 'ollama',
      utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat`, performNpcId: 'character:companion' })
    try {
      const state = await runtime.submit(rejected
        ? '/act interact {"targetRef":{"kind":"entity","id":"entity:shared-umbrella"},"bindingId":"binding:umbrella-take","definitionRef":{"id":"base:take","version":1},"arguments":{}}'
        : '/act speak {"text":"帮我拿一下伞吧。"}')
      expect(state.error).toBe(false)
      expect(heldBeforeContinuation).toBe(rejected ? 'character:player' : 'character:companion')
      expect(continuationCount).toBe(1)
      const status = rejected ? 'rejected' : 'accepted'
      expect(actualContinuation).toMatchObject(reuseReaction ? { executionResult: { status } }
        : { continuation: true, result: { status } })
      expect(JSON.stringify(continuationMessages)).not.toContain('PARTICIPANT_NOT_AUTHORIZED')
      if (rejected) expect(JSON.stringify(actualContinuation)).toContain('旅人')
      expect(JSON.stringify(actualContinuation)).toContain('下一次可执行决策')
      if (reuseReaction) {
        expect(state.debug.performReactionContinuation).toMatchObject({ calls: 1, stage: 'submitted_to_existing_validator' })
        expect(state.debug.performContinuation).toBeNull()
      } else expect(state.debug.performContinuation).toMatchObject({ calls: 1, status: 'published' })
      expect(state.transcript.some(line => line.text.includes(narration))).toBe(true)
      // Remount and another ordinary input remain usable after the additional committed publication.
      expect((await runtime.submit('/act speak {"text":"谢谢。"}')).error).toBe(false)
      expect(continuationCount).toBe(1)
    } finally { await runtime.close() }
  }, 60_000)

  it('lets the player type, and records what the world did with it', async () => {
    const { asked, server } = scriptedEndpoint(takesBinding('binding:umbrella-take'))
    const root = mkdtempSync(join(tmpdir(), 'frozen-playtest-'))
    roots.push(root)
    const runtime = await play(asked, server, root)
    try {
      const state = await runtime.submit('我把共用的伞拿起来。')
      // The world moved: the transcript is built from the player's own observations, not from the input.
      expect(state.transcript.some(line => line.text.includes('shared-umbrella'))).toBe(true)
      expect(state.error).toBe(false)
      expect(state.debug).toMatchObject({ outputProtocol: 'submit_actions/v7', manifestVersion: 10,
        playerInputMode: 'interpreted-free-text' })
      // Root participation asks both characters. They abstain here, so this fixture opens no Reaction Cycle.
      expect(asked.filter(call => !JSON.stringify(call.format).includes('player-intent-candidate'))).toHaveLength(2)
      const character = asked.find(call => !JSON.stringify(call.format).includes('player-intent-candidate'))!
      const schema = JSON.stringify(character.format)
      // The model is handed the world's own contract: the frozen protocol, the group's steps, its cues.
      expect(schema).toContain('"const":7')
      expect(schema).toContain('"actionType":{"type":"string","const":"interact"')
      expect(character.messages[0]!.role).toBe('system')
      // An explicit command is the same request without asking the interpreter anything.
      const before = asked.filter(call => JSON.stringify(call.format).includes('player-intent-candidate')).length
      const command = await runtime.submit('/act interact {"targetRef":{"kind":"character","id":"character:companion"},'
        + '"bindingId":"binding:companion-hold-hand","definitionRef":{"id":"base:hold-hand","version":1},"arguments":{}}')
      expect(command.error).toBe(false)
      expect(asked.filter(call => JSON.stringify(call.format).includes('player-intent-candidate')).length).toBe(before)
    } finally { await runtime.close() }
  }, 60_000)

  it('keeps ordinary expressions visible without opening a bystander Reaction Cycle', async () => {
    const { asked, server } = scriptedEndpoint(takesBinding('binding:umbrella-take'), true)
    const root = mkdtempSync(join(tmpdir(), 'frozen-playtest-reaction-drain-'))
    roots.push(root)
    const runtime = await play(asked, server, root)
    try {
      const state = await runtime.submit('我把共用的伞拿起来。')
      const characterCalls = asked.filter(call => !JSON.stringify(call.format).includes('player-intent-candidate'))
      expect(state.transcript.some(line => line.text === '（指尖蜷起，又慢慢松开。）')).toBe(true)
      // Both expressions remain visible, without generating bystander calls.
      expect(characterCalls).toHaveLength(2)
      expect(state.debug.terminalReason).not.toBe('call_limit')
    } finally { await runtime.close() }
  }, 60_000)

  it('ends a dialogue-triggered wave when only unaddressed expressions follow', async () => {
    const { asked, server } = scriptedEndpoint(takesBinding('binding:umbrella-take'), 'dialogue-then-expression')
    const root = mkdtempSync(join(tmpdir(), 'frozen-expression-wave-'))
    roots.push(root)
    const runtime = await play(asked, server, root)
    try {
      const state = await runtime.submit('我把共用的伞拿起来。')
      expect(asked.filter(call => !JSON.stringify(call.format).includes('player-intent-candidate'))).toHaveLength(4)
      expect(state.transcript.some(line => line.text === '（轻轻点头。）')).toBe(true)
      expect(state.debug).toMatchObject({ cycleStatus: 'terminal', terminalReason: 'quiescent' })
    } finally { await runtime.close() }
  }, 60_000)

  it('publishes nothing when a dialogue-triggered wave chooses abstain', async () => {
    const { asked, server } = scriptedEndpoint(takesBinding('binding:umbrella-take'), 'dialogue-then-abstain')
    const root = mkdtempSync(join(tmpdir(), 'frozen-abstain-wave-'))
    roots.push(root)
    const runtime = await play(asked, server, root)
    try {
      const state = await runtime.submit('我把共用的伞拿起来。')
      expect(asked.filter(call => !JSON.stringify(call.format).includes('player-intent-candidate'))).toHaveLength(4)
      expect(state.transcript.filter(line => line.text.includes('你好。'))).toHaveLength(2)
      expect(state.debug).toMatchObject({ cycleStatus: 'terminal', terminalReason: 'all_abstained' })
    } finally { await runtime.close() }
  }, 60_000)

  it('walks a character somewhere, because the world said where it may go', async () => {
    // Before the destinations were offered, a move named an id the model invented and the world refused it
    // after the call was paid for. Now the option carries the world's own places and the step lands.
    const { asked, server } = scriptedEndpoint(moving)
    const root = mkdtempSync(join(tmpdir(), 'frozen-playtest-move-'))
    roots.push(root)
    const runtime = await play(asked, server, root)
    try {
      const state = await runtime.submit('我们走到另一个地方去吧。')
      expect(state.error).toBe(false)
      expect(state.notice).toBe('')
      expect(state.transcript.some(line => line.text.includes('移动到了另一个地点'))).toBe(true)
      // The model was handed the destinations, which is what made the choice possible at all.
      const shown = asked.find(call => JSON.stringify(call.format).includes('locationId'))!
      expect(JSON.stringify(shown.format)).toContain('"enum":["location:')
    } finally { await runtime.close() }
  }, 60_000)

  it('completes a queued input when it is retried under its own key', async () => {
    // What a retry has to be: the same words under the same key. The store is idempotent by key, so the
    // turn lands once - not twice, which is what a fresh key for the same sentence would do.
    const { asked, server } = scriptedEndpoint(takesBinding('binding:umbrella-take'))
    const root = mkdtempSync(join(tmpdir(), 'frozen-playtest-retry-'))
    roots.push(root)
    const runtime = await play(asked, server, root)
    try {
      const key = 'web-playtest:retry-of-one-input'
      const first = await runtime.submit('我把共用的伞拿起来。', key)
      const rounds = (first.debug as { headSeq: number }).headSeq
      const again = await runtime.submit('我把共用的伞拿起来。', key)
      // The same input twice is one commit: the head does not move a second time.
      expect((again.debug as { headSeq: number }).headSeq).toBe(rounds)
      expect(runtime.address).toBeDefined()
    } finally { await runtime.close() }
  }, 60_000)

  it('says an input that never reached the world can be retried', async () => {
    // The other half of the failure notice: an input the world never received is the one case where saying
    // it again is the right advice. The text is what the player reads, so it is pinned here.
    const { asked, server } = scriptedEndpoint(takesBinding('binding:umbrella-take'))
    const root = mkdtempSync(join(tmpdir(), 'frozen-playtest-refused-'))
    roots.push(root)
    const runtime = await play(asked, server, root)
    await runtime.close()
    await expect(runtime.submit('我把共用的伞拿起来。')).rejects.toThrow()
    const state = await runtime.state()
    expect(state.error).toBe(true)
    expect(state.notice).toContain('没有被世界受理')
    expect(state.notice).toContain('重新说一次')
  }, 60_000)

  it('keeps the world when the page is stopped and started again on the same directory', async () => {
    const first = scriptedEndpoint(takesBinding('binding:umbrella-take'))
    const root = mkdtempSync(join(tmpdir(), 'frozen-playtest-restart-'))
    roots.push(root)
    const runtime = await play(first.asked, first.server, root)
    let afterFirst: Awaited<ReturnType<typeof runtime.state>>
    try { afterFirst = await runtime.submit('我把共用的伞拿起来。') } finally { await runtime.close() }
    const second = scriptedEndpoint(takesBinding('binding:umbrella-give'))
    const reopened = await play(second.asked, second.server, root)
    try {
      const resumed = await reopened.state()
      // The world is where it was left: the same address, the same history in the transcript.
      expect(resumed.transcript).toEqual(afterFirst.transcript)
      expect(resumed.debug).toMatchObject({ headSeq: (afterFirst.debug as { headSeq: number }).headSeq })
      // And it keeps going: another turn moves it further, without repeating the first.
      const next = await reopened.submit('我把伞递给同行者。')
      expect(next.error).toBe(false)
      expect((next.debug as { headSeq: number }).headSeq).toBeGreaterThan((afterFirst.debug as { headSeq: number }).headSeq)
    } finally { await reopened.close() }
  }, 60_000)
})
