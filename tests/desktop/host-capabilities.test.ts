import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { brandId } from '@harness-world/contracts'
import { HostCapabilities, type CapabilityProvider, type CapabilityWorld } from '../../desktop/host-capabilities.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
const schema = { type: 'object', additionalProperties: false, properties: {} }
const requirement = { id: 'fixture', version: '1', required: true, config: {}, characters: ['character:companion'] }
function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  return new HostCapabilities(ctx)
}
function world(id: string, called: string[] = []): CapabilityWorld {
  return {
    address: {
      tenantId: brandId('tenant:test', 'TenantId'),
      worldId: brandId(id, 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    },
    worldVersion: id,
    requestCharacter: async characterId => {
      called.push(characterId)
      return { status: 'completed' }
    },
  }
}

it('opens separate world services, validates schemas and binds role callbacks to declared characters and lifetime', async () => {
  const catalog = fixture(),
    scopes: CapabilityWorld[] = [],
    calls: string[] = []
  let closes = 0
  catalog.register({
    id: 'fixture',
    version: '1',
    methods: { inspect: { arguments: schema, result: { type: 'string' }, effect: 'read' } },
    open: async scope => {
      scopes.push(scope)
      return {
        invoke: async () => ({ completion: 'completed', data: scope.worldVersion }),
        close: async () => {
          closes++
        },
      }
    },
  })
  const first = await catalog.attach(world('world:first', calls), [requirement]),
    second = await catalog.attach(world('world:second'), [requirement])
  expect(await first.invoke('fixture', 'inspect', {}, 'character:companion')).toEqual({
    completion: 'completed',
    data: 'world:first',
  })
  expect(await second.invoke('fixture', 'inspect', {}, 'character:companion')).toEqual({
    completion: 'completed',
    data: 'world:second',
  })
  await expect(first.invoke('fixture', 'inspect', { unexpected: true }, 'character:companion')).rejects.toThrow(
    'schema',
  )
  await expect(scopes[0]!.requestCharacter('character:other')).rejects.toThrow('not bound')
  await scopes[0]!.requestCharacter('character:companion')
  expect(calls).toEqual(['character:companion'])
  const metadata = catalog.list()
  expect(Object.keys(metadata[0]!).sort()).toEqual(['id', 'methods', 'version'])
  ;(metadata[0]!.methods.inspect!.arguments as { type: string }).type = 'string'
  expect(catalog.list()[0]!.methods.inspect!.arguments.type).toBe('object')
  await first.close()
  await expect(scopes[0]!.requestCharacter('character:companion')).rejects.toThrow('closed')
  expect(second.has('fixture', 'inspect')).toBe(true)
  await second.close()
  expect(closes).toBe(2)
})

it('unregister cancels pending work, closes bound services and cannot remove a replacement provider', async () => {
  const catalog = fixture()
  let finish!: (value: { completion: 'completed'; data: string }) => void,
    closed = 0,
    cancelled = false
  const provider: CapabilityProvider = {
    id: 'fixture',
    version: '1',
    methods: { run: { arguments: schema, result: { type: 'string' }, effect: 'external' } },
    open: async () => ({
      invoke: async (_method, _args, _actor, signal) => {
        signal.addEventListener('abort', () => {
          cancelled = true
        })
        return new Promise(done => {
          finish = done
        })
      },
      close: async () => {
        closed++
      },
    }),
  }
  const unregister = catalog.register(provider),
    session = await catalog.attach(world('world:test'), [requirement])
  const pending = expect(session.invoke('fixture', 'run', {}, 'character:companion')).rejects.toThrow(
    'EXTERNAL_RESULT_UNKNOWN',
  )
  await unregister()
  await pending
  finish({ completion: 'completed', data: 'late' })
  expect(cancelled).toBe(true)
  expect(closed).toBe(1)
  expect(session.resultUnknown).toBe(true)
  catalog.register(provider)
  await unregister()
  expect(catalog.list()).toHaveLength(1)
})

it('rejects required version mismatch and closes earlier services when a later attachment fails', async () => {
  const catalog = fixture()
  let closed = 0
  catalog.register({
    id: 'fixture',
    version: '1',
    methods: { read: { arguments: schema, result: schema, effect: 'read' } },
    open: async () => ({
      invoke: async () => ({ completion: 'completed', data: {} }),
      close: async () => {
        closed++
      },
    }),
  })
  await expect(catalog.attach(world('world:test'), [{ ...requirement, version: '2' }])).rejects.toThrow(
    'Required capability unavailable',
  )
  const optional = await catalog.attach(world('world:test'), [{ ...requirement, version: '2', required: false }])
  expect(optional.has('fixture', 'read')).toBe(false)
  await optional.close()
  await expect(catalog.attach(world('world:test'), [requirement, { ...requirement, id: 'missing' }])).rejects.toThrow(
    'missing',
  )
  expect(closed).toBe(1)
})
