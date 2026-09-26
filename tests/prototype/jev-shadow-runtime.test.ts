import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { currentEntityState } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import { type ShadowRecord } from '../experiments/jev-shadow.ts'
import { claimCriteria, type ClaimQuestion, type ClaimKind } from '../experiments/jev-shadow-claims-client.ts'

it('the actual web runtime publishes while Jev is pending and has the same model calls, transcript and world results with shadow off/on', async () => {
  async function play(enabled: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'jev-shadow-web-'))
    let calls = 0, performed = false
    const records: ShadowRecord[] = [], questions: ClaimQuestion[] = []
    let started!: () => void, release!: () => void
    const classifierStarted = new Promise<void>(done => { started = done })
    const blocked = new Promise<void>(done => { release = done })
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        calls += 1
        const input = JSON.parse(JSON.parse(body).messages.at(-1).content)
        let output: unknown = { decision: 'abstain' }
        if (input.context.character.characterId === 'character:companion') {
          if (input.continuation) output = { decision: 'publish', speech: '拿到了。', narration: '黄铜钥匙已经在同行者手里。' }
          else if (!performed) {
            performed = true
            output = { decision: 'perform', actionType: 'interact', parameters: {
              targetRef: { kind: 'entity', id: 'entity:brass-key' }, bindingId: 'binding:key-take',
              definitionRef: { id: 'base:take', version: 1 }, arguments: {},
            } }
          }
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: { content: JSON.stringify(output) } }))
      })
    })
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', () => ready()))
    const port = (server.address() as { port: number }).port
    let runtime: FrozenWorldPlaytestRuntime | undefined
    try {
      runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
        packPath: resolve('examples/world-packs/prototype-g1'), provider: 'ollama', model: 'fixture',
        utilityEndpoint: `http://127.0.0.1:${port}/api/chat`,
        ...(enabled ? { shadowAudit: {
          items: [{ entityId: 'entity:brass-key', name: '黄铜钥匙' }],
          classify: async (question: ClaimQuestion) => {
            questions.push(question); started(); await blocked
            const kind: ClaimKind = question.publication.narration ? 'OBJECTIVE_NOW' : 'NONE'
            return { model: 'fixture', inputTokens: 1, outputTokens: 1, costUsd: 0,
              claims: question.characters.map(c => ({ characterId: c.characterId, kind: c.characterId === 'character:companion' ? kind : 'NONE',
                referenceSeq: null, confidence: 1, probabilities: Object.fromEntries(Object.keys(claimCriteria).map(label => [label,label === kind ? 1 : 0])), referenceProbabilities:{ NONE:1 } })) }
          }, write: async (record: ShadowRecord) => { records.push(record) },
        } } : {}),
      })
      const state = await runtime.submit('/act speak {"text":"请拿起黄铜钥匙。"}')
      expect(state.error).toBe(false)
      expect(state.transcript.some(line => line.text.includes('黄铜钥匙已经在同行者手里'))).toBe(true)
      const read = () => {
        const store = new WorldStore(resolve(root, 'world.sqlite'))
        try { return store.readEvents(runtime!.address) } finally { store.close() }
      }
      const beforeAudit = read()
      expect(currentEntityState(beforeAudit, 'entity:brass-key')?.holderId).toBe('character:companion')
      if (enabled) {
        await classifierStarted
        expect(records).toHaveLength(0) // submit returned even though the audit cannot finish.
        expect(questions[0]?.publication.actorId).toBe('character:player')
      }
      release()
      await runtime.close(); runtime = undefined
      const store = new WorldStore(resolve(root, 'world.sqlite'))
      try { expect(JSON.stringify(store.readEvents(beforeAudit[0]!.address))).toBe(JSON.stringify(beforeAudit)) } finally { store.close() }
      if (enabled) {
        expect(records.map(row => row.status)).toEqual(['NO_CLAIM', 'SUPPORTED'])
        expect(records[1]?.publication).toMatchObject({ actorId: 'character:companion', speech: '拿到了。', narration: '黄铜钥匙已经在同行者手里。' })
        expect(records[1]?.holderEventSeq).not.toBeNull()
      }
      return { calls, transcript: state.transcript.map(line => line.text), eventTypes: beforeAudit.map(event => event.eventType) }
    } finally {
      release(); await runtime?.close()
      await new Promise<void>((done, reject) => server.close(error => error === undefined ? done() : reject(error)))
      rmSync(root, { recursive: true, force: true })
    }
  }
  expect(await play(true)).toEqual(await play(false))
}, 30_000)
