import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Tokenizer } from '@huggingface/tokenizers'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { createRuntimeWithCore } from '../support/core-memory-options.ts'
import { fakeModels } from '../support/fake-provider.ts'
import { coreAdapter } from '../support/core-adapter.ts'
import { restoreStoryNode } from '../../apps/host/src/story-nodes.ts'
import { object, rows, text } from '../../packages/memory-core/src/node/archive.ts'

const assets = resolve(process.env.HCW_HINDSIGHT_ONNX_DIR ?? '.tmp/hindsight-e5-small')
function removeTemporary(root: string) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('node-memory-host-'))
    throw new Error('Unexpected temporary path')
  rmSync(root, { recursive: true, force: true })
}

// Opt-in real native inference: ordinary CI need not download model assets.
it.skipIf(!existsSync(join(assets, 'onnx/model_quantized.onnx')))(
  'default Node Host builds and recalls real E5 archives and restores a story node without a utility call',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-memory-host-'))
    const data = join(root, 'origin'),
      restored = join(root, 'restored')
    const contexts: WorldJsonObject[] = []
    const workerEvents = vi.spyOn(Worker.prototype, 'emit')
    let utilityCalls = 0
    const provider = createServer((req, res) => {
      let body = ''
      req.on('data', c => {
        body += String(c)
      })
      req.on('end', () => {
        const wire = JSON.parse(body),
          messages = wire.messages as { role: string; content: string }[]
        const system = messages.find(m => m.role === 'system')?.content ?? ''
        const user = JSON.parse(messages.at(-1)!.content)
        let answer: WorldJsonObject
        if (system.startsWith('Split authorized evidence')) {
          utilityCalls++
          answer = { atoms: [] }
        } else if (system.startsWith('Organize Event Atoms')) {
          utilityCalls++
          answer = { groups: [{ episode_id: null, label: '喝茶约定', atom_ids: rows(user.newAtoms).map(a => a.id!) }] }
        } else if (system.startsWith('Form revisable SUBJECTIVE')) {
          utilityCalls++
          const atoms = rows(user.atoms).filter(a => text(a.text).includes('桂花热茶'))
          answer = {
            observations: atoms.length
              ? [
                  {
                    observation_id: null,
                    text: '旅人说喜欢桂花热茶，约定明天再见。',
                    supporting_atom_ids: atoms.map(a => a.id!),
                    contradicting_atom_ids: [],
                  },
                ]
              : [],
          }
        } else {
          contexts.push(object(user.context))
          answer = { decision: 'abstain' }
        }
        if (wire.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const chunk = (delta: WorldJsonObject, finish: string | null) =>
            'data: ' +
            JSON.stringify({
              id: 'fixture',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta, finish_reason: finish }],
            }) +
            '\n\n'
          res.end(
            chunk({ role: 'assistant', content: JSON.stringify(answer) }, null) +
              chunk({}, 'stop') +
              'data: [DONE]\n\n',
          )
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] }),
          )
        }
      })
    })
    provider.listen(0, '127.0.0.1')
    await once(provider, 'listening')
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('Missing local model port')
    vi.stubEnv('HCW_HINDSIGHT_ONNX_DIR', assets)
    vi.stubEnv('HCW_HINDSIGHT_PYTHON', join(root, 'python-must-not-exist.exe'))
    const options = {
      packPath: resolve('examples/world-packs/ai-girls-hosted-guess'),
      models: fakeModels(`http://127.0.0.1:${address.port}/v1/chat/completions`),
      memoryCore: true,
      storyNodes: true,
    }
    let runtime: Awaited<ReturnType<typeof createRuntimeWithCore>> | undefined
    try {
      runtime = await createRuntimeWithCore({ ...options, dataDirectory: data })
      expect((await runtime.submit('我喜欢桂花热茶，明天在茶室再见。')).error).toBe(false)
      await runtime.refreshMemory()
      await runtime.waitForMemory()
      const workerErrors = workerEvents.mock.calls.flatMap(([event, value]) =>
        event === 'message' && value?.error ? [value.error.message] : event === 'error' ? [String(value)] : [],
      )
      expect((await runtime.state()).memoryMaintenance?.failed, JSON.stringify(workerErrors)).toBe(0)
      expect(utilityCalls).toBeGreaterThan(0)
      const adapter = coreAdapter(runtime.dataDirectory, runtime.address, async () => {
        throw new Error('restore must not run memory')
      })
      let snapshots: WorldJsonObject
      try {
        snapshots = adapter.snapshotArchives(['character:claude'])
        const cache = object(snapshots['character:claude'])
        expect(rows(object(cache.archive).facts).length).toBeGreaterThan(0)
        expect(rows(object(cache.archive).observations).length).toBeGreaterThan(0)
        expect((object(cache.index).vectors as number[][])[0]).toHaveLength(384)
        const tampered = structuredClone(snapshots)
        rows(object(object(tampered['character:claude']).archive).sources)[0]!.text = '篡改'
        expect(() => adapter.restoreArchives(tampered, ['character:claude'])).toThrow('source prefix changed')
      } finally {
        await adapter.close()
      }
      const before = utilityCalls
      contexts.length = 0
      expect((await runtime.submit('还记得我喜欢什么茶吗？')).error).toBe(false)
      expect(contexts.some(c => JSON.stringify(c.memories).includes('桂花热茶'))).toBe(true)
      expect(utilityCalls).toBe(before)
      const tokenizer = new Tokenizer(
        JSON.parse(readFileSync(join(assets, 'tokenizer.json'), 'utf8')),
        JSON.parse(readFileSync(join(assets, 'tokenizer_config.json'), 'utf8')),
      )
      const queries = workerEvents.mock.calls.flatMap(([event, value]) =>
        event === 'message' && value?.result?.query?.mode === 'search' ? [value.result.query] : [],
      )
      expect(queries.length).toBeGreaterThan(0)
      for (const query of queries)
        expect(query.tokenCount).toBe(tokenizer.encode('query: ' + query.semanticQuery).ids.length)
      const node = await runtime.saveNode('Node 记忆节点')
      expect(utilityCalls).toBe(before)
      const origin = runtime.dataDirectory
      await runtime.close()
      runtime = undefined
      restoreStoryNode(origin, node.id, restored, node.packHash)
      runtime = await createRuntimeWithCore({ ...options, dataDirectory: restored })
      expect(utilityCalls).toBe(before)
      const reader = coreAdapter(runtime.dataDirectory, runtime.address, async () => {
        throw new Error('snapshot must not run memory')
      })
      try {
        expect(reader.snapshotArchives(['character:claude'])).toEqual(snapshots)
      } finally {
        await reader.close()
      }
      contexts.length = 0
      expect((await runtime.submit('明天喝什么茶？')).error).toBe(false)
      expect(contexts.some(c => JSON.stringify(c.memories).includes('桂花热茶'))).toBe(true)
      expect(utilityCalls).toBe(before)
    } finally {
      await runtime?.close()
      provider.closeAllConnections()
      await new Promise<void>(done => provider.close(() => done()))
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
      removeTemporary(root)
    }
  },
  180_000,
)
