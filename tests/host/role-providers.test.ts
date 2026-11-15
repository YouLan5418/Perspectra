import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RequestInspector } from '@harness-world/provider-chat'
import { createRoleProviders } from '../../packages/official-llm/src/role-providers.ts'
import { playSettings } from '../../desktop/play-settings.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'
import { brandId } from '@harness-world/contracts'

const cleanups: (() => Promise<void>)[] = []

it('sends two characters to their separately selected connections and protocols', async () => {
  const first = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  const second = await startFakeProvider('anthropic', () => ({ tool: { decision: 'abstain' } }))
  cleanups.push(first.close, second.close)
  const observed: string[] = []
  const roles = createRoleProviders(
    {
      models: {
        default: { decision: { protocol: 'openai', endpoint: first.endpoint, model: 'first-model' } },
        characters: { b: { decision: { protocol: 'anthropic', endpoint: second.endpoint, model: 'second-model' } } },
      },
    },
    playSettings({}),
    ['a', 'b'].map(id => ({ actorId: brandId(id, 'CharacterId') })),
    new RequestInspector(),
    () => {},
    id => observed.push(id),
  )
  const call = {
    messages: [
      { role: 'system' as const, content: 'contract' },
      { role: 'user' as const, content: 'authorized context' },
    ],
    schema: { type: 'object' },
    description: 'fixture',
  }
  await roles.byCharacter.get('a')!.decide(call, new AbortController().signal)
  await roles.byCharacter.get('b')!.decide(call, new AbortController().signal)
  expect(roles.protocols.get('a')).toBe('openai')
  expect(roles.protocols.get('b')).toBe('anthropic')
  expect(first.calls).toHaveLength(1)
  expect(second.calls).toHaveLength(1)
  expect(first.calls[0]!.body.model).toBe('first-model')
  expect(second.calls[0]!.body.model).toBe('second-model')
  expect(observed).toEqual(['a', 'b'])
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

for (const cacheMode of ['prompt-key', 'openrouter', 'opencode-go'] as const)
  it(
    cacheMode + ': keeps each character cache key across interleaved calls and starts new namespaces on reopening',
    async () => {
      const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
      cleanups.push(server.close)
      const build = () =>
        createRoleProviders(
          {
            models: {
              default: {
                decision: { protocol: 'openai', endpoint: server.endpoint, model: 'fixture', cacheMode },
              },
              characters: {},
            },
          },
          playSettings({}),
          ['a', 'b'].map(id => ({ actorId: brandId(id, 'CharacterId') })),
          new RequestInspector(),
          () => {},
          () => {},
        )
      const call = {
        messages: [
          { role: 'system', content: 'contract' },
          { role: 'user', content: 'authorized context' },
        ],
        schema: { type: 'object' },
        description: 'fixture',
      }
      const roles = build()
      for (const id of ['a', 'b', 'a', 'b']) await roles.byCharacter.get(id)!.decide(call, new AbortController().signal)
      const key = (index: number) =>
        cacheMode === 'opencode-go'
          ? server.calls[index]!.headers['x-opencode-session']
          : server.calls[index]!.body[cacheMode === 'openrouter' ? 'session_id' : 'prompt_cache_key']
      const keys = server.calls.map((_, index) => key(index))
      expect(keys[0]).toMatch(/^[a-f0-9-]{36}$/)
      expect(keys[0]).toBe(keys[2])
      expect(keys[1]).toBe(keys[3])
      expect(keys[0]).not.toBe(keys[1])
      await build().byCharacter.get('a')!.decide(call, new AbortController().signal)
      expect(key(4)).not.toBe(keys[0])
      expect(server.calls[0]!.body.messages).toEqual(call.messages)
    },
  )

it('waits 60 seconds per call when no play settings are given', () => {
  const roles = createRoleProviders(
    { models: fakeModels('http://127.0.0.1:9/v1/chat/completions') },
    playSettings({}),
    [],
    new RequestInspector(),
    () => {},
    () => {},
  )
  expect(roles.timeoutMs).toBe(60_000)
})

for (const [protocol, flattened] of [
  ['openai', true],
  ['google', false],
] as const)
  it(`${protocol}: ${flattened ? 'flattens' : 'keeps'} the root oneOf of the decision schema`, async () => {
    const server = await startFakeProvider(protocol, () => ({ tool: { decision: 'abstain' } }))
    const root = await mkdtemp(join(tmpdir(), 'role-schema-'))
    cleanups.push(server.close, () => rm(root, { recursive: true, force: true }))
    const runtime = await WorldHostRuntime.create({
      dataDirectory: root,
      packPath: resolve('examples/world-packs/prototype-g1'),
      models: fakeModels(server.endpoint, protocol),
    })
    cleanups.push(() => runtime.close())
    await runtime.submit('你好。')
    const body = server.calls[0]!.body as {
      tools: {
        function?: { parameters: { oneOf?: unknown } }
        functionDeclarations?: { parametersJsonSchema: { oneOf?: unknown } }[]
      }[]
    }
    const schema = body.tools[0]!.function?.parameters ?? body.tools[0]!.functionDeclarations![0]!.parametersJsonSchema
    expect(schema.oneOf === undefined).toBe(flattened)
  })
