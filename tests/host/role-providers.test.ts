import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RequestInspector } from '@harness-world/provider-chat'
import { createRoleProviders } from '../../desktop/host/role-providers.ts'
import { playSettings } from '../../desktop/play-settings.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

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
