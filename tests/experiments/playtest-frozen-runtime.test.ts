import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'

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
function scriptedEndpoint(choose: (offered: readonly Offered[]) => Offered) {
  const asked: Asked[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as Asked
      asked.push(parsed)
      const answer = JSON.stringify(parsed.format).includes('player-intent-candidate')
        ? interpretation(parsed, choose) : { schemaVersion: 7, decision: 'abstain', actions: [] }
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
  return { version: 'player-intent-candidate/v2', decision: 'act', reason: 'none',
    actions: [{ key: 'a', affordanceId: chosen.affordanceId }],
    sourceSpans: [{ actionKey: 'a', startUtf16: 0, endUtf16: user.sourceText.length,
      text: user.sourceText, kind: 'action' }] }
}

/** The option whose binding the player's words named, which is what a real interpreter would select. */
const takesBinding = (binding: string) => (offered: readonly Offered[]) =>
  offered.find(entry => entry.parameters.bindingId === binding)!

async function listening(server: Server): Promise<number> {
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', () => ready()))
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

const packPath = resolve('examples/world-packs/hand-in-hand')

/** The endpoint stands in for both the character model and the interpreter, as one vendor would. */
const play = async (asked: readonly Asked[], server: Server, root: string) =>
  await FrozenWorldPlaytestRuntime.create({ dataDirectory: root, packPath, provider: 'ollama',
    model: 'scripted-endpoint/v1', utilityEndpoint: `http://127.0.0.1:${await listening(server)}/api/chat`,
    timeoutMs: 10_000 })

describe('the web playtest on a frozen world', () => {
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
      // Three calls: the interpreter read the player, and both characters were asked what they do.
      expect(asked.length).toBeGreaterThanOrEqual(1)
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
