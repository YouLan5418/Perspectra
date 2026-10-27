import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { WorldStore } from '@harness-world/store-sqlite'
import { currentEntityState } from '@harness-world/kernel'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'

for (const protocol of ['openai', 'anthropic', 'google'] as const) {
  it(`${protocol}: real HTTP carries executed results into continuation; private world effects still commit through Rulebook`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-runtime-'))
    let calls = 0
    const server = await startFakeProvider(protocol, call => {
      const input = JSON.parse(call.userText)
      let answer: unknown = { decision: 'abstain' }
      if (input.context.character.characterId === 'character:companion') {
        calls++
        if (calls <= 2) {
          expect(input.canPerform).toBe(true)
          if (calls === 2) expect(input.result.status).toBe('accepted')
          const operation = calls === 1 ? 'take' : 'drop'
          answer = {
            decision: 'perform',
            actionType: 'interact',
            parameters: {
              targetRef: { kind: 'entity', id: 'entity:brass-key' },
              bindingId: 'status',
              definitionRef: { id: 'status:' + operation, version: 1 },
              arguments: {},
            },
          }
        } else {
          expect(input.canPerform).toBe(false)
          expect(input.result.status).toBe('accepted')
          answer = { decision: 'publish', segments: [{ type: 'speech', text: '钥匙已放回。' }] }
        }
      }
      return { tool: answer }
    })
    let runtime: WorldHostRuntime | undefined
    try {
      runtime = await WorldHostRuntime.create({
        dataDirectory: root,
        packPath: resolve('examples/world-packs/prototype-g1'),
        models: fakeModels(server.endpoint, protocol),
      })
      const result = await runtime.submit('请看看钥匙。')
      expect(result.error).toBe(false)
      expect(calls).toBe(3)
      expect(result.transcript.some(line => line.text.includes('钥匙已放回'))).toBe(true)
      const store = new WorldStore(join(root, 'world.sqlite'))
      try {
        const events = store.readEvents(runtime.address)
        expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(2)
        expect(currentEntityState(events, 'entity:brass-key')?.holderId).toBeNull()
      } finally {
        store.close()
      }
    } finally {
      await runtime?.close()
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
}
