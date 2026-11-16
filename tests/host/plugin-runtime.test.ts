import { CommunicationPolicy } from '@perspectra/providers/communication'
import { guardedCommunication } from '../../apps/host/src/runtime/gameplay-services.ts'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorldInstanceScope } from '@perspectra/core/runtime'
import {
  callPluginAsync,
  callPluginSync,
  createPluginCallContext,
  hostCallback,
} from '../../apps/host/src/runtime/plugin-runtime.ts'
const scopes: Awaited<ReturnType<typeof createWorldInstanceScope>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const scope of scopes.splice(0)) await scope.close()
})
async function context() {
  const scope = await createWorldInstanceScope(new Context())
  scopes.push(scope)
  return createPluginCallContext(scope)
}
it('keeps an observed plugin fault when the plugin aborts and fails in the same call', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const ctx = await context(),
    controller = new AbortController()
  const pending = callPluginAsync(ctx, 'test', 'run', controller.signal, async () => {
    controller.abort()
    throw new TypeError('PRIVATE_NATIVE_CONTEXT')
  })
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(ctx.diagnostics).toHaveLength(1)
  expect(ctx.diagnostics[0]).toMatchObject({ pluginId: 'test', operation: 'run' })
  expect(JSON.stringify(ctx.diagnostics)).not.toContain('PRIVATE_NATIVE_CONTEXT')
  expect(log.mock.calls.flat().join(' ')).not.toContain('PRIVATE_NATIVE_CONTEXT')
})
it('records a late plugin rejection after ending the cancelled wait', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const ctx = await context(),
    controller = new AbortController()
  let reject!: (error: unknown) => void, entered!: () => void
  const ready = new Promise<void>(resolve => {
    entered = resolve
  })
  const pending = callPluginAsync(ctx, 'late', 'run', controller.signal, () => {
    entered()
    return new Promise((_resolve, fail) => {
      reject = fail
    })
  })
  await ready
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  reject(new Error('PRIVATE_LATE_CONTEXT'))
  await vi.waitFor(() => expect(ctx.diagnostics).toHaveLength(1))
})
it('does not diagnose ordinary cancellation or classify a host failure as a plugin fault', async () => {
  const ctx = await context(),
    controller = new AbortController()
  const pending = callPluginAsync(ctx, 'cancel', 'run', controller.signal, async signal => {
    controller.abort()
    throw signal.reason
  })
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(ctx.diagnostics).toEqual([])
  const core = new Error('core storage')
  expect(() =>
    callPluginSync(ctx, 'test', 'run', () =>
      hostCallback(ctx.callbacks, () => {
        throw core
      }),
    ),
  ).toThrow(core)
  expect(ctx.diagnostics).toEqual([])
})

it('attributes malformed message options to the provider before core admission', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const ctx = await context()
  const instance = new CommunicationPolicy({ config: { medium: 'SMS', contacts: { p: ['n'] } } })
  instance.options = () => [{ targetRef: { kind: 'character', id: 'n' } }] as never
  const report = vi.fn()
  const guarded = guardedCommunication(instance, true, 'broken-message', ctx, report)
  expect(() => guarded.options({ actorId: 'p', recipientIds: ['n'], publicationCharacters: 100 })).toThrow(
    'broken-message',
  )
  expect(ctx.diagnostics).toMatchObject([{ pluginId: 'broken-message', operation: 'options', invalidResult: true }])
  expect(report).toHaveBeenCalledOnce()
})
